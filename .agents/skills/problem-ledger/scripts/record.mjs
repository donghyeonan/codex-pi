#!/usr/bin/env node
// Problem ledger recorder for the current project: writes Markdown under ./problem-hub/.
// Usage: node .agents/skills/problem-ledger/scripts/record.mjs '<action JSON>'
import fs from 'node:fs';
import path from 'node:path';
import { archiveProblem, linkProblemSession, listProblemPage, openProblem, recordTrial, resolveProblem } from '../lib/problem-ledger.mjs';

const root = path.join(process.cwd(), 'problem-hub');
const schemas = path.join(root, 'schemas');
if (!fs.existsSync(schemas)) fs.cpSync(path.join(import.meta.dirname, '..', 'schemas'), schemas, { recursive: true });
for (const dir of ['tickets', 'attempts', 'resolutions', 'evidence']) fs.mkdirSync(path.join(root, dir), { recursive: true });
const defaultProject = path.basename(process.cwd()).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

const actions = {
  list: input => ({ action: 'listed', ...listProblemPage({ ...input, root }) }),
  open: input => openProblem({ ...input, root, project: input.scope === 'project' ? (input.project || defaultProject) : input.project }),
  'link-session': input => linkProblemSession({ ...input, root }),
  trial: input => recordTrial({ ...input, root }),
  resolve: input => resolveProblem({ ...input, root }),
  archive: input => archiveProblem({ ...input, root }),
};

try {
  const input = JSON.parse(process.argv[2] ?? '');
  const run = actions[input?.action];
  if (!run) throw new Error(`action must be one of: ${Object.keys(actions).join(', ')}`);
  console.log(JSON.stringify(run(input), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
