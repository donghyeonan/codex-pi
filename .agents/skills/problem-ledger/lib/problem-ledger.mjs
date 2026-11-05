import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProblemHub } from '../scripts/problem-hub.mjs';
import { parseFrontmatter } from './frontmatter.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'inconclusive', 'abandoned']);
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
const DISPLAY_TITLE_LENGTH = 240;

function hubPath(root) {
  if (fs.existsSync(path.join(root, 'hub', 'schemas'))) return path.join(root, 'hub');
  return path.basename(root) === 'problem-hub' ? root : path.join(root, 'projects', 'problem-hub');
}

function assertText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function normalizeProject(value) {
  const project = assertText(value, 'project').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(project)) throw new Error('project must contain only lowercase letters, numbers, and hyphens');
  return project;
}

function projectToken(project) {
  return project.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'GENERAL';
}

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

function document(frontmatter, body) {
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${scalar(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n${body.trim()}\n`;
}

function validatedRecords(root) {
  const validation = validateProblemHub(root);
  if (validation.errors.length) {
    const detail = validation.errors.map(error => `${error.path ?? 'problem-hub'}${error.field ? ` [${error.field}]` : ''}: ${error.message}`).join(' | ');
    throw new Error(`Problem ledger is invalid before mutation: ${detail}`);
  }
  return validation.records;
}

function resolveProject(root, cwd) {
  const configPath = path.join(root, 'config', 'project-map.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const absoluteCwd = path.resolve(cwd);
  const candidates = (config.projects ?? [])
    .filter(project => typeof project?.id === 'string' && typeof project?.path === 'string')
    .map(project => ({ id: project.id, path: path.resolve(project.path) }))
    .filter(project => absoluteCwd === project.path || absoluteCwd.startsWith(`${project.path}${path.sep}`))
    .sort((left, right) => right.path.length - left.path.length);
  if (!candidates.length) throw new Error(`cannot infer a project for cwd ${absoluteCwd}; provide project explicitly or use general scope`);
  return normalizeProject(candidates[0].id);
}

function ticketReference(ticket) {
  return `${ticket.frontmatter.project}#${ticket.frontmatter.number}`;
}

function findTicket(records, reference) {
  const requested = assertText(reference, 'ticket');
  const exact = records.find(record => record.type === 'ticket' && record.frontmatter.id === requested);
  if (exact) return exact;
  const match = requested.toLowerCase().match(/^([a-z0-9-]+)#([1-9][0-9]*)$/);
  if (!match) throw new Error('ticket must be an internal id or a project reference such as mohae#3');
  const [, project, number] = match;
  const found = records.filter(record => record.type === 'ticket'
    && record.frontmatter.project === project
    && record.frontmatter.number === Number(number));
  if (found.length !== 1) throw new Error(found.length ? `ticket reference ${requested} is ambiguous` : `ticket ${requested} does not exist`);
  return found[0];
}

function nextRecordId(records, type, prefix) {
  const numbers = records
    .filter(record => record.type === type && record.frontmatter.id.startsWith(`${prefix}-`))
    .map(record => Number(record.frontmatter.id.match(/([0-9]+)$/)?.[1] ?? 0));
  return `${prefix}-${String(Math.max(0, ...numbers) + 1).padStart(4, '0')}`;
}

function mutate(root, changes) {
  const hub = hubPath(root);
  const lockPath = path.join(hub, '.write.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx');
  } catch (cause) {
    if (cause?.code === 'EEXIST') throw new Error('another Problem ledger mutation is in progress');
    throw cause;
  }

  const backups = new Map();
  const staged = [];
  try {
    for (const change of changes) {
      fs.mkdirSync(path.dirname(change.path), { recursive: true });
      const current = fs.existsSync(change.path) ? fs.readFileSync(change.path, 'utf8') : null;
      if (Object.hasOwn(change, 'expected') && current !== change.expected) {
        throw new Error(`concurrent modification of ${change.path}; retry against the current record`);
      }
      backups.set(change.path, current);
      const temporary = `${change.path}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(temporary, change.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      staged.push({ temporary, target: change.path });
    }
    for (const item of staged) fs.renameSync(item.temporary, item.target);
    const validation = validateProblemHub(root);
    if (validation.errors.length) {
      throw new Error(validation.errors.map(error => `${error.path ?? 'problem-hub'}${error.field ? ` [${error.field}]` : ''}: ${error.message}`).join(' | '));
    }
  } catch (cause) {
    for (const item of staged) {
      if (fs.existsSync(item.temporary)) fs.rmSync(item.temporary, { force: true });
    }
    for (const [target, original] of backups) {
      if (original === null) fs.rmSync(target, { force: true });
      else fs.writeFileSync(target, original, 'utf8');
    }
    throw new Error(`Problem ledger mutation rolled back: ${cause.message}`);
  } finally {
    if (lock !== undefined) fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

function sessionReferences(...values) {
  const refs = [];
  for (const value of values) {
    if (value === null || value === undefined) continue;
    for (const reference of Array.isArray(value) ? value : [value]) {
      const text = assertText(reference, 'session reference');
      if (/[\r\n\0`]/.test(text)) throw new Error('session references must be single-line IDs or paths without backticks');
      if (!refs.includes(text)) refs.push(text);
    }
  }
  return refs;
}

function ticketSessionChange(target, incoming, timestamp) {
  if (!incoming.length) return null;
  const original = fs.readFileSync(target.absolutePath, 'utf8');
  const parsed = parseFrontmatter(original, { source: target.path });
  const refs = sessionReferences(parsed.frontmatter.source_session, parsed.frontmatter.source_sessions, incoming);
  if (JSON.stringify(parsed.frontmatter.source_sessions) === JSON.stringify(refs)) return null;
  const section = `## Conversation references\n\n${refs.map(ref => `- \`${ref}\``).join('\n')}`;
  const body = parsed.body.replace(/\n## Conversation references\n[\s\S]*?(?=\n## |$)/, '').trim();
  return {
    path: target.absolutePath,
    expected: original,
    content: document({ ...parsed.frontmatter, source_sessions: refs, updated_at: timestamp }, `${body}\n\n${section}`)
  };
}

export function linkProblemSession({ root = DEFAULT_ROOT, ticket, sourceSession = null, sourceSessions = [], now = () => new Date() }) {
  const records = validatedRecords(root);
  const target = findTicket(records, ticket);
  const incoming = sessionReferences(sourceSession, sourceSessions);
  if (!incoming.length) throw new Error('provide at least one session reference');
  const change = ticketSessionChange(target, incoming, now().toISOString());
  if (change) mutate(root, [change]);
  const updated = parseFrontmatter(fs.readFileSync(target.absolutePath, 'utf8')).frontmatter;
  return { action: change ? 'session_linked' : 'unchanged', ticket: ticketReference(target), status: derivedTicketStatus(records, target), sourceSession: updated.source_session ?? null, sourceSessions: updated.source_sessions, path: path.relative(root, target.absolutePath) };
}

function acceptedResolution(records, ticketId) {
  return records.find(record => record.type === 'resolution'
    && record.frontmatter.ticket_id === ticketId
    && record.frontmatter.status === 'accepted');
}

export function derivedTicketStatus(records, ticket) {
  const resolution = acceptedResolution(records, ticket.frontmatter.id);
  return resolution ? (resolution.frontmatter.disposition ?? 'resolved') : 'open';
}

function derivedTicketUpdatedAt(records, ticket) {
  const childDates = records
    .filter(record => (record.type === 'attempt' || record.type === 'resolution')
      && record.frontmatter.ticket_id === ticket.frontmatter.id)
    .map(record => record.frontmatter.updated_at);
  return [ticket.frontmatter.updated_at, ...childDates].sort().at(-1);
}

function validateListStatus(status) {
  if (!['all', 'open', 'resolved', 'legacy'].includes(status)) throw new Error('status must be all, open, resolved, or legacy');
}

function compareTickets(left, right) {
  return left.project.localeCompare(right.project)
    || Number(left.ticket.split('#')[1]) - Number(right.ticket.split('#')[1]);
}

function ticketProblemBody(record) {
  const body = parseFrontmatter(fs.readFileSync(record.absolutePath, 'utf8'), { source: record.path }).body;
  return body.match(/(?:^|\n)## Problem or improvement\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? '';
}

function boundedTitle(title) {
  const characters = Array.from(title);
  return characters.length <= DISPLAY_TITLE_LENGTH
    ? title
    : `${characters.slice(0, DISPLAY_TITLE_LENGTH - 1).join('')}…`;
}

function assertPageInteger(value, name, { minimum, maximum }) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    const range = maximum === undefined ? `${minimum} or greater` : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be a finite integer ${range}`);
  }
  return value;
}

export function listProblems({ root = DEFAULT_ROOT, project, status = 'open' } = {}) {
  validateListStatus(status);
  const selectedProject = project ? normalizeProject(project) : null;
  const records = validatedRecords(root);
  return records
    .filter(record => record.type === 'ticket')
    .filter(record => !selectedProject || record.frontmatter.project === selectedProject)
    .map(record => ({ record, derivedStatus: derivedTicketStatus(records, record) }))
    .filter(({ derivedStatus }) => status === 'all' || derivedStatus === status)
    .map(({ record, derivedStatus }) => ({
      ticket: ticketReference(record),
      id: record.frontmatter.id,
      title: record.frontmatter.title,
      project: record.frontmatter.project,
      scope: record.frontmatter.scope,
      reportedBy: record.frontmatter.reported_by,
      status: derivedStatus,
      updatedAt: derivedTicketUpdatedAt(records, record),
      sourceSession: record.frontmatter.source_session ?? null,
      sessionReferenceCount: sessionReferences(record.frontmatter.source_session, record.frontmatter.source_sessions).length
    }))
    .sort(compareTickets);
}

export function listProblemPage({
  root = DEFAULT_ROOT,
  project,
  status = 'open',
  query,
  limit = DEFAULT_LIST_LIMIT,
  offset = 0
} = {}) {
  validateListStatus(status);
  const selectedProject = project ? normalizeProject(project) : null;
  const pageLimit = assertPageInteger(limit, 'limit', { minimum: 1, maximum: MAX_LIST_LIMIT });
  const pageOffset = assertPageInteger(offset, 'offset', { minimum: 0 });
  if (query !== undefined && typeof query !== 'string') throw new Error('query must be a string');
  const tokens = (query ?? '').trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const records = validatedRecords(root);
  const matches = records
    .filter(record => record.type === 'ticket')
    .filter(record => !selectedProject || record.frontmatter.project === selectedProject)
    .map(record => ({ record, derivedStatus: derivedTicketStatus(records, record) }))
    .filter(({ derivedStatus }) => status === 'all' || derivedStatus === status)
    .filter(({ record }) => {
      if (!tokens.length) return true;
      const searchable = [
        record.frontmatter.id,
        ticketReference(record),
        record.frontmatter.title,
        ticketProblemBody(record),
        ...(Array.isArray(record.frontmatter.tags) ? record.frontmatter.tags : [])
      ].join('\n').toLocaleLowerCase();
      return tokens.every(token => searchable.includes(token));
    })
    .map(({ record, derivedStatus }) => ({
      ticket: ticketReference(record),
      id: record.frontmatter.id,
      title: boundedTitle(record.frontmatter.title),
      project: record.frontmatter.project,
      scope: record.frontmatter.scope,
      reportedBy: record.frontmatter.reported_by,
      status: derivedStatus,
      updatedAt: derivedTicketUpdatedAt(records, record)
    }))
    .sort(compareTickets);
  const tickets = matches.slice(pageOffset, pageOffset + pageLimit);
  const next = pageOffset + tickets.length;
  return {
    tickets,
    total: matches.length,
    limit: pageLimit,
    offset: pageOffset,
    nextOffset: next < matches.length ? next : null
  };
}

export function openSkillCandidate({
  root = DEFAULT_ROOT,
  cwd = process.cwd(),
  scope,
  project,
  title,
  skillTarget,
  repeatedProblem,
  proposedRule,
  evidencePaths,
  cause = 'repeated-problem',
  sourceSession = null,
  now = () => new Date()
}) {
  const target = assertText(skillTarget, 'skillTarget');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(target)) throw new Error('skillTarget must be a skill name or qualified skill path without spaces');
  const normalizedCause = assertText(cause, 'cause');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(normalizedCause)) throw new Error('cause must be a tag-safe token without spaces');
  if (!Array.isArray(evidencePaths)) throw new Error('evidencePaths must be an array');
  const evidence = [...new Set(evidencePaths.map(value => assertText(value, 'evidence path')))];
  if (evidence.length < 2) throw new Error('skill candidates require at least two independent evidence paths');
  const problem = assertText(repeatedProblem, 'repeatedProblem');
  const rule = assertText(proposedRule, 'proposedRule');
  const key = createHash('sha256')
    .update(`${target.toLowerCase()}\0${rule.replace(/\s+/g, ' ').toLowerCase()}`)
    .digest('hex')
    .slice(0, 20);
  const keyTag = `skill-candidate-key:${key}`;
  const records = validatedRecords(root);
  const existing = records.find(record => record.type === 'ticket'
    && Array.isArray(record.frontmatter.tags)
    && record.frontmatter.tags.includes(keyTag));
  if (existing) {
    return {
      action: 'unchanged',
      id: existing.frontmatter.id,
      ticket: ticketReference(existing),
      project: existing.frontmatter.project,
      scope: existing.frontmatter.scope,
      status: derivedTicketStatus(records, existing),
      path: path.relative(root, existing.absolutePath)
    };
  }
  const description = `## Repeated problem\n\n${problem}\n\n## Proposed reusable rule\n\n${rule}\n\n## Evidence\n\n${evidence.map(value => `- ${value}`).join('\n')}`;
  return openProblem({
    root,
    cwd,
    scope,
    reportedBy: 'assistant',
    project,
    title,
    description,
    sourceSession,
    tags: ['skill-candidate', 'skill', `skill-target:${target}`, `cause:${normalizedCause}`, keyTag],
    now
  });
}

export function openProblem({ root = DEFAULT_ROOT, cwd = process.cwd(), scope, reportedBy = 'user', project, title, description = '', sourceSession = null, sourceSessions = [], tags = [], now = () => new Date() }) {
  if (scope !== 'project' && scope !== 'general') throw new Error('scope must be project or general');
  if (!['user', 'assistant', 'tool'].includes(reportedBy)) throw new Error('reportedBy must be user, assistant, or tool');
  const resolvedProject = scope === 'general' ? 'general' : normalizeProject(project || resolveProject(root, cwd));
  if (scope === 'general' && project && project !== 'general') throw new Error('general-scope tickets always belong to the general collection');
  const records = validatedRecords(root);
  const timestamp = now().toISOString();
  const tickets = records.filter(record => record.type === 'ticket' && record.frontmatter.project === resolvedProject);
  const number = Math.max(0, ...tickets.map(record => Number(record.frontmatter.number) || 0)) + 1;
  const token = projectToken(resolvedProject);
  const id = `${token}-TICKET-${String(number).padStart(3, '0')}`;
  if (records.some(record => record.frontmatter.id === id)) throw new Error(`generated duplicate ticket id ${id}`);

  const ticketPath = path.join(hubPath(root), 'tickets', `${id}.md`);
  const detail = typeof description === 'string' && description.trim() ? description.trim() : 'No additional detail recorded.';
  const refs = sessionReferences(sourceSession, sourceSessions);
  const references = refs.length ? `\n\n## Conversation references\n\n${refs.map(ref => `- \`${ref}\``).join('\n')}` : '';
  const ticket = document({
    schema_version: 2, type: 'ticket', id, number, scope, reported_by: reportedBy,
    source_session: sourceSession, source_sessions: refs, title: assertText(title, 'title'), project: resolvedProject,
    created_at: timestamp, updated_at: timestamp, tags: Array.isArray(tags) ? tags : []
  }, `# ${assertText(title, 'title')}\n\n## Problem or improvement\n\n${detail}${references}`);
  mutate(root, [{ path: ticketPath, content: ticket, expected: null }]);
  return { action: 'opened', id, ticket: `${resolvedProject}#${number}`, project: resolvedProject, scope, status: 'open', path: path.relative(root, ticketPath) };
}

export function recordTrial({ root = DEFAULT_ROOT, ticket, title, approach, result, outcome, sourceSession = null, sourceSessions = [], now = () => new Date() }) {
  const records = validatedRecords(root);
  const target = findTicket(records, ticket);
  const status = derivedTicketStatus(records, target);
  if (status !== 'open') throw new Error(`ticket ${ticketReference(target)} is already ${status}`);
  if (outcome !== 'running' && !TERMINAL_OUTCOMES.has(outcome)) throw new Error('outcome must be running, succeeded, failed, inconclusive, or abandoned');
  const attempts = records.filter(record => record.type === 'attempt' && record.frontmatter.ticket_id === target.frontmatter.id);
  const sequence = Math.max(0, ...attempts.map(record => Number(record.frontmatter.sequence) || 0)) + 1;
  const timestamp = now().toISOString();
  const prefix = `ATT-${projectToken(target.frontmatter.project)}`;
  const id = nextRecordId(records, 'attempt', prefix);
  const attemptPath = path.join(hubPath(root), 'attempts', `${id}.md`);
  const terminal = outcome !== 'running';
  const trialTitle = typeof title === 'string' && title.trim() ? title.trim() : `Trial ${sequence} for ${ticketReference(target)}`;
  const attempt = document({
    schema_version: 1, type: 'attempt', id, title: trialTitle, project: target.frontmatter.project,
    ticket_id: target.frontmatter.id, status: terminal ? 'completed' : 'running', outcome, sequence,
    source_session: sourceSession, source_sessions: sessionReferences(sourceSession, sourceSessions),
    created_at: timestamp, started_at: timestamp, ended_at: terminal ? timestamp : null, updated_at: timestamp
  }, `# ${trialTitle}\n\n## Approach\n\n${assertText(approach, 'approach')}\n\n## Result\n\n${assertText(result, 'result')}`);
  const link = ticketSessionChange(target, sessionReferences(sourceSession, sourceSessions), timestamp);
  mutate(root, [{ path: attemptPath, content: attempt, expected: null }, ...(link ? [link] : [])]);
  return { action: 'trial_recorded', id, ticket: ticketReference(target), sequence, outcome, path: path.relative(root, attemptPath) };
}

export function resolveProblem(input) {
  return closeProblem({ ...input, disposition: 'resolved' });
}

export function archiveProblem(input) {
  return closeProblem({ ...input, disposition: 'legacy' });
}

function closeProblem({ root = DEFAULT_ROOT, ticket, title, decision, result, disposition, sourceSession = null, sourceSessions = [], now = () => new Date() }) {
  const records = validatedRecords(root);
  const target = findTicket(records, ticket);
  const status = derivedTicketStatus(records, target);
  if (status !== 'open') throw new Error(`ticket ${ticketReference(target)} is already ${status}`);
  const timestamp = now().toISOString();
  const prefix = `RES-${projectToken(target.frontmatter.project)}`;
  const id = nextRecordId(records, 'resolution', prefix);
  const resolutionTitle = assertText(title, 'title');
  const resolutionPath = path.join(hubPath(root), 'resolutions', `${id}.md`);
  const resolution = document({
    schema_version: 1, type: 'resolution', id, title: resolutionTitle, project: target.frontmatter.project,
    ticket_id: target.frontmatter.id, status: 'accepted', disposition, decided_at: timestamp,
    source_session: sourceSession, source_sessions: sessionReferences(sourceSession, sourceSessions),
    created_at: timestamp, updated_at: timestamp, supersedes: null
  }, `# ${resolutionTitle}\n\n## Decision\n\n${assertText(decision, 'decision')}\n\n## Result\n\n${assertText(result, 'result')}`);
  const link = ticketSessionChange(target, sessionReferences(sourceSession, sourceSessions), timestamp);
  mutate(root, [{ path: resolutionPath, content: resolution, expected: null }, ...(link ? [link] : [])]);
  return { action: disposition === 'legacy' ? 'archived' : 'resolved', id, ticket: ticketReference(target), status: disposition, path: path.relative(root, resolutionPath) };
}
