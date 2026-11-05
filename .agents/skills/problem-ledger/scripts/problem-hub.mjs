import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMON_REQUIRED_FIELDS = ['schema_version', 'type', 'id', 'title', 'project', 'created_at', 'updated_at'];
const RECORD_TYPES = {
  tickets: { type: 'ticket', schema: 'ticket.schema.json' },
  attempts: { type: 'attempt', schema: 'attempt.schema.json' },
  evidence: { type: 'evidence', schema: 'evidence.schema.json' },
  resolutions: { type: 'resolution', schema: 'resolution.schema.json' }
};
const SUPPORTED_SCHEMA_ROOT_KEYS = new Set(['$schema', '$id', 'title', 'type', 'additionalProperties', 'required', 'properties']);
const SUPPORTED_PROPERTY_KEYS = new Set(['type', 'const', 'enum', 'minLength', 'pattern', 'format', 'uniqueItems', 'items', 'minimum']);
const SUPPORTED_JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null']);
const SUPPORTED_FORMATS = new Set(['date-time', 'uri']);

function isIsoDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.map(part => part === undefined ? part : Number(part));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour !== undefined && (offsetHour > 23 || offsetMinute > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

function hasJsonType(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function normaliseHubPath(root) {
  if (fs.existsSync(path.join(root, 'hub', 'schemas'))) return path.join(root, 'hub');
  return path.basename(root) === 'problem-hub' ? root : path.join(root, 'projects', 'problem-hub');
}

function assertSupportedPropertyRule(rule, location) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`${location} must be an object`);
  for (const key of Object.keys(rule)) {
    if (!SUPPORTED_PROPERTY_KEYS.has(key)) throw new Error(`${location} uses unsupported JSON Schema keyword "${key}"`);
  }
  if (rule.type !== undefined) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.length || types.some(type => typeof type !== 'string' || !SUPPORTED_JSON_TYPES.has(type)) || new Set(types).size !== types.length) {
      throw new Error(`${location}.type must contain unique supported JSON types`);
    }
  }
  if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length)) throw new Error(`${location}.enum must be a non-empty array`);
  if (rule.minLength !== undefined && (!Number.isInteger(rule.minLength) || rule.minLength < 0)) throw new Error(`${location}.minLength must be a non-negative integer`);
  if (rule.pattern !== undefined) {
    if (typeof rule.pattern !== 'string') throw new Error(`${location}.pattern must be a string`);
    try { new RegExp(rule.pattern); } catch { throw new Error(`${location}.pattern must be a valid regular expression`); }
  }
  if (rule.format !== undefined && !SUPPORTED_FORMATS.has(rule.format)) throw new Error(`${location}.format must be one of ${[...SUPPORTED_FORMATS].join(', ')}`);
  if (rule.uniqueItems !== undefined && typeof rule.uniqueItems !== 'boolean') throw new Error(`${location}.uniqueItems must be boolean`);
  if (rule.minimum !== undefined && (typeof rule.minimum !== 'number' || !Number.isFinite(rule.minimum))) throw new Error(`${location}.minimum must be a finite number`);
  if (rule.items !== undefined) assertSupportedPropertyRule(rule.items, `${location}.items`);
}

function assertSupportedSchema(schema, source) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${source} must contain an object schema`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_ROOT_KEYS.has(key)) throw new Error(`${source} uses unsupported JSON Schema keyword "${key}"`);
  }
  if (schema.type !== 'object') throw new Error(`${source} root type must be "object"`);
  if (typeof schema.additionalProperties !== 'boolean') throw new Error(`${source} additionalProperties must be boolean`);
  if (!Array.isArray(schema.required) || schema.required.some(field => typeof field !== 'string') || new Set(schema.required).size !== schema.required.length) {
    throw new Error(`${source} required must contain unique strings`);
  }
  if (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) throw new Error(`${source} properties must be an object`);
  for (const [field, rule] of Object.entries(schema.properties)) assertSupportedPropertyRule(rule, `${source}.properties.${field}`);
}

function loadSchemas(hubPath) {
  const schemas = new Map();
  for (const definition of Object.values(RECORD_TYPES)) {
    const source = path.join(hubPath, 'schemas', definition.schema);
    const schema = JSON.parse(fs.readFileSync(source, 'utf8'));
    assertSupportedSchema(schema, source);
    schemas.set(definition.type, schema);
  }
  return schemas;
}

function addDiagnostic(errors, record, message, field = null) {
  errors.push({ path: record?.path ?? null, field, message });
}

function validateSchema(record, schema, errors) {
  const data = record.frontmatter;
  for (const field of new Set([...COMMON_REQUIRED_FIELDS, ...(schema.required ?? [])])) {
    if (!Object.hasOwn(data, field)) addDiagnostic(errors, record, 'is required', field);
  }
  for (const field of ['created_at', 'updated_at']) {
    if (Object.hasOwn(data, field) && !schema.properties?.[field]?.format && !isIsoDateTime(data[field])) {
      addDiagnostic(errors, record, 'must be an ISO 8601 date-time with a timezone', field);
    }
  }

  if (schema.additionalProperties === false) {
    for (const field of Object.keys(data)) {
      if (!Object.hasOwn(schema.properties ?? {}, field)) addDiagnostic(errors, record, 'is not declared by the schema', field);
    }
  }

  for (const [field, rule] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field];
    const allowedTypes = Array.isArray(rule.type) ? rule.type : rule.type ? [rule.type] : [];
    if (allowedTypes.length && !allowedTypes.some(type => hasJsonType(value, type))) {
      addDiagnostic(errors, record, `must be ${allowedTypes.join(' or ')}`, field);
      continue;
    }
    if (Object.hasOwn(rule, 'const') && value !== rule.const) addDiagnostic(errors, record, `must equal ${JSON.stringify(rule.const)}`, field);
    if (rule.enum && !rule.enum.includes(value)) addDiagnostic(errors, record, `must be one of ${rule.enum.join(', ')}`, field);
    if (typeof value === 'string') {
      if (rule.minLength && value.length < rule.minLength) addDiagnostic(errors, record, `must contain at least ${rule.minLength} character`, field);
      if (rule.pattern && !(new RegExp(rule.pattern).test(value))) addDiagnostic(errors, record, 'has an invalid format', field);
      if (rule.format === 'date-time' && !isIsoDateTime(value)) addDiagnostic(errors, record, 'must be an ISO 8601 date-time with a timezone', field);
      if (rule.format === 'uri') {
        try { new URL(value); } catch { addDiagnostic(errors, record, 'must be an absolute URI', field); }
      }
    }
    if (Array.isArray(value)) {
      if (rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) addDiagnostic(errors, record, 'must not contain duplicates', field);
      if (rule.items?.type) {
        const itemTypes = Array.isArray(rule.items.type) ? rule.items.type : [rule.items.type];
        if (value.some(item => !itemTypes.some(type => hasJsonType(item, type)))) addDiagnostic(errors, record, `must contain only ${itemTypes.join(' or ')} values`, field);
      }
    }
    if (typeof value === 'number') {
      if (rule.minimum !== undefined && value < rule.minimum) addDiagnostic(errors, record, `must be at least ${rule.minimum}`, field);
    }
  }
}

function addReferenceError(errors, record, field, id, expectedTypes, recordsById) {
  if (typeof id !== 'string' || !id) return;
  const target = recordsById.get(id);
  if (!target) {
    addDiagnostic(errors, record, `references missing record "${id}"`, field);
  } else if (!expectedTypes.includes(target.type)) {
    addDiagnostic(errors, record, `must reference ${expectedTypes.join(' or ')}, not ${target.type}`, field);
  }
}

function validateReferences(records, recordsById, errors) {
  for (const record of records) {
    const data = record.frontmatter;
    const many = (field, types) => {
      if (Array.isArray(data[field])) data[field].forEach(id => addReferenceError(errors, record, field, id, types, recordsById));
    };
    const one = (field, types) => addReferenceError(errors, record, field, data[field], types, recordsById);

    if (record.type === 'ticket') {
      one('parent_id', ['ticket']);
      many('depends_on', ['ticket']);
    }
    if (record.type === 'attempt') one('ticket_id', ['ticket']);
    if (record.type === 'resolution') {
      one('ticket_id', ['ticket']);
      one('supersedes', ['resolution']);
      many('evidence_ids', ['evidence']);
      many('follow_up_ticket_ids', ['ticket']);
    }
    if (record.type === 'evidence') one('supports', ['ticket', 'attempt', 'resolution']);

  }
}

function validateProjectConsistency(records, recordsById, errors) {
  for (const record of records) {
    const data = record.frontmatter;
    if (record.type === 'ticket') {
      const parent = recordsById.get(data.parent_id);
      if (parent?.type === 'ticket' && parent.frontmatter.project !== data.project) {
        addDiagnostic(errors, record, `parent ticket "${data.parent_id}" belongs to project "${parent.frontmatter.project}"`, 'parent_id');
      }
    }
    if (record.type === 'attempt') {
      const ticket = recordsById.get(data.ticket_id);
      if (ticket?.type === 'ticket' && ticket.frontmatter.project !== data.project) {
        addDiagnostic(errors, record, `ticket "${data.ticket_id}" belongs to project "${ticket.frontmatter.project}"`, 'ticket_id');
      }
    }
    if (record.type === 'resolution') {
      const ticket = recordsById.get(data.ticket_id);
      if (ticket?.type === 'ticket' && ticket.frontmatter.project !== data.project) {
        addDiagnostic(errors, record, `ticket "${data.ticket_id}" belongs to project "${ticket.frontmatter.project}"`, 'ticket_id');
      }
      const superseded = recordsById.get(data.supersedes);
      if (superseded?.type === 'resolution' && superseded.frontmatter.ticket_id !== data.ticket_id) {
        addDiagnostic(errors, record, `superseded resolution "${data.supersedes}" belongs to ticket "${superseded.frontmatter.ticket_id}"`, 'supersedes');
      }
    }
  }
}

function validateTicketAndAttemptStates(records, errors) {
  const acceptedByTicket = new Map();
  for (const record of records) {
    if (record.type !== 'resolution' || record.frontmatter.status !== 'accepted') continue;
    const ticketId = record.frontmatter.ticket_id;
    if (!acceptedByTicket.has(ticketId)) acceptedByTicket.set(ticketId, []);
    acceptedByTicket.get(ticketId).push(record);
  }
  for (const [ticketId, resolutions] of acceptedByTicket) {
    if (resolutions.length > 1) {
      for (const resolution of resolutions.slice(1)) {
        addDiagnostic(errors, resolution, `ticket "${ticketId}" has more than one accepted resolution`, 'ticket_id');
      }
    }
  }

  for (const record of records) {
    const data = record.frontmatter;
    if (record.type === 'attempt') {
      if (data.status === 'running') {
        if (data.outcome !== 'running') addDiagnostic(errors, record, 'running attempts must have outcome "running"', 'outcome');
        if (data.ended_at !== null && data.ended_at !== undefined) addDiagnostic(errors, record, 'running attempts must not have ended_at', 'ended_at');
      }
      if (data.status === 'completed') {
        if (data.outcome === 'running') addDiagnostic(errors, record, 'completed attempts require a terminal outcome', 'outcome');
        if (typeof data.ended_at !== 'string' || !isIsoDateTime(data.ended_at)) addDiagnostic(errors, record, 'completed attempts require an ISO ended_at', 'ended_at');
      }
      if (isIsoDateTime(data.started_at) && isIsoDateTime(data.ended_at) && Date.parse(data.ended_at) < Date.parse(data.started_at)) {
        addDiagnostic(errors, record, 'ended_at cannot be before started_at', 'ended_at');
      }
    }
  }
}

function validateTicketIdentities(records, errors) {
  const seen = new Map();
  for (const record of records) {
    if (record.type !== 'ticket') continue;
    const data = record.frontmatter;
    const key = `${data.project}\u0000${data.number}`;
    const previous = seen.get(key);
    if (previous) {
      addDiagnostic(errors, record, `duplicates ticket number #${data.number} in project "${data.project}" also used by ${previous.path}`, 'number');
    } else {
      seen.set(key, record);
    }
    if (data.scope === 'general' && data.project !== 'general') {
      addDiagnostic(errors, record, 'general-scope tickets must belong to the general collection', 'project');
    }
    if (data.scope === 'project' && data.project === 'general') {
      addDiagnostic(errors, record, 'the general collection must use general scope', 'scope');
    }
  }
}

function validateUniqueAttemptSequences(records, errors) {
  const seen = new Map();
  for (const record of records) {
    if (record.type !== 'attempt') continue;
    const key = `${record.frontmatter.ticket_id}\u0000${record.frontmatter.sequence}`;
    const previous = seen.get(key);
    if (previous) {
      addDiagnostic(errors, record, `duplicates sequence ${record.frontmatter.sequence} for ticket "${record.frontmatter.ticket_id}" also used by ${previous.path}`, 'sequence');
    } else {
      seen.set(key, record);
    }
  }
}

function validateDirectedCycles(records, recordsById, errors, { recordType, field, targets, label }) {
  const state = new Map();
  const stack = [];
  const reported = new Set();

  const visit = record => {
    state.set(record.frontmatter.id, 1);
    stack.push(record.frontmatter.id);
    for (const targetId of targets(record.frontmatter)) {
      const target = recordsById.get(targetId);
      if (target?.type !== recordType) continue;
      if (state.get(targetId) === 1) {
        const start = stack.indexOf(targetId);
        const cycle = [...stack.slice(start), targetId];
        const signature = cycle.join(' -> ');
        if (!reported.has(signature)) {
          reported.add(signature);
          addDiagnostic(errors, record, `${label} cycle: ${signature}`, field);
        }
      } else if (!state.has(targetId)) {
        visit(target);
      }
    }
    stack.pop();
    state.set(record.frontmatter.id, 2);
  };

  for (const record of records) {
    if (record.type === recordType && !state.has(record.frontmatter.id)) visit(record);
  }
}

function validateCycles(records, recordsById, errors) {
  validateDirectedCycles(records, recordsById, errors, {
    recordType: 'ticket', field: 'depends_on', label: 'dependency',
    targets: data => Array.isArray(data.depends_on) ? data.depends_on : []
  });
  validateDirectedCycles(records, recordsById, errors, {
    recordType: 'ticket', field: 'parent_id', label: 'parent',
    targets: data => typeof data.parent_id === 'string' ? [data.parent_id] : []
  });
  validateDirectedCycles(records, recordsById, errors, {
    recordType: 'resolution', field: 'supersedes', label: 'resolution supersession',
    targets: data => typeof data.supersedes === 'string' ? [data.supersedes] : []
  });
}

/** Validate the repository's canonical Problem Hub records without mutating them. */
export function validateProblemHub(root = ROOT) {
  const hubPath = normaliseHubPath(path.resolve(root));
  const errors = [];
  const records = [];
  let schemas;
  try {
    schemas = loadSchemas(hubPath);
  } catch (cause) {
    return { hubPath, records, errors: [{ path: null, field: null, message: `cannot load schemas: ${cause.message}` }] };
  }

  for (const [directory, definition] of Object.entries(RECORD_TYPES)) {
    const recordDirectory = path.join(hubPath, directory);
    let files;
    try {
      files = fs.readdirSync(recordDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
        .map(entry => entry.name)
        .sort();
    } catch (cause) {
      errors.push({ path: path.relative(path.dirname(hubPath), recordDirectory), field: null, message: `cannot read record directory: ${cause.message}` });
      continue;
    }
    for (const filename of files) {
      const absolutePath = path.join(recordDirectory, filename);
      const relativePath = path.relative(path.dirname(hubPath), absolutePath);
      try {
        const parsed = parseFrontmatter(fs.readFileSync(absolutePath, 'utf8'), { source: relativePath });
        const record = { path: relativePath, absolutePath, type: definition.type, frontmatter: parsed.frontmatter };
        records.push(record);
        validateSchema(record, schemas.get(definition.type), errors);
        if (record.frontmatter.type !== definition.type) addDiagnostic(errors, record, `must have type "${definition.type}" for the ${directory}/ directory`, 'type');
      } catch (cause) {
        errors.push({ path: relativePath, field: null, message: cause.message });
      }
    }
  }

  const recordsById = new Map();
  for (const record of records) {
    const id = record.frontmatter.id;
    if (typeof id !== 'string' || !id) continue;
    if (recordsById.has(id)) {
      addDiagnostic(errors, record, `duplicates id "${id}" also used by ${recordsById.get(id).path}`, 'id');
    } else {
      recordsById.set(id, record);
    }
  }
  validateReferences(records, recordsById, errors);
  validateProjectConsistency(records, recordsById, errors);
  validateTicketAndAttemptStates(records, errors);
  validateTicketIdentities(records, errors);
  validateUniqueAttemptSequences(records, errors);
  validateCycles(records, recordsById, errors);

  return { hubPath, records, errors };
}

function renderErrors(errors) {
  for (const error of errors) {
    const field = error.field ? ` [${error.field}]` : '';
    console.error(`- ${error.path ?? 'problem-hub'}${field}: ${error.message}`);
  }
}

function main(args) {
  if (args.length !== 1 || args[0] !== 'validate') {
    console.error('Usage: node scripts/problem-hub.mjs validate');
    return 1;
  }
  const result = validateProblemHub();
  if (result.errors.length) {
    console.error(`Problem Hub validation failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}):`);
    renderErrors(result.errors);
    return 1;
  }
  console.log(`Problem Hub validation passed (${result.records.length} records).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
