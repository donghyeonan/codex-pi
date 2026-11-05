// Design references: the bundled stageshow skill's examples (stills in canvas/refs, metadata read from the
// vendored SKILL.md) plus the user's own library <userDir>/<category>/<name>.(png|jpg|jpeg|webp) with optional <name>.md.
// Only ids returned by listRefs are readable, so request ids can never escape these directories.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REFS = {
  stillsDir: path.join(HERE, 'refs', 'stageshow'),
  skillDir: path.join(HERE, '..', '.agents', 'skills', 'stageshow'),
  userDir: path.join(os.homedir(), '.codex-pi', 'refs'),
};
const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const SECTIONS = { Gold: 'stageshow · gold', 'Product studies': 'stageshow · 제품', 'Specimen and reference sheets': 'stageshow · 부품' };
const MAX_NOTE = 4000;

async function entries(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// SKILL.md tables: | Need | `example`, `other` | What to learn |
export function parseStageshowTables(markdown) {
  const out = new Map(); let category = null;
  for (const line of markdown.split('\n')) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) { category = SECTIONS[h[1].trim()] || null; continue; }
    if (/^##\s/.test(line)) category = null;
    const cells = line.split('|').map((c) => c.trim());
    if (!category || cells.length < 5 || !cells[2].includes('`')) continue;
    for (const [, id] of cells[2].matchAll(/`([a-z0-9-]+)`/g)) if (!out.has(id)) out.set(id, { category, need: cells[1], learn: cells[3] });
  }
  return out;
}

export async function listRefs({ stillsDir, skillDir, userDir }) {
  const out = [];
  const meta = parseStageshowTables(await fsp.readFile(path.join(skillDir, 'SKILL.md'), 'utf8').catch(() => ''));
  for (const e of await entries(stillsDir)) {
    const ext = path.extname(e.name).toLowerCase(), example = path.basename(e.name, ext);
    if (!e.isFile() || !IMAGE[ext]) continue;
    const m = meta.get(example) || { category: 'stageshow · 기타', need: '', learn: '' };
    out.push({ id: `stageshow/${example}`, title: example, category: m.category, need: m.need, path: path.join(stillsDir, e.name), learn: m.learn, source: path.join(skillDir, 'examples', example) });
  }
  const add = (category, dir, file, rel) => {
    const ext = path.extname(file).toLowerCase();
    if (IMAGE[ext] && !file.startsWith('.')) out.push({ id: `mine/${rel}`, title: path.basename(file, ext), category, path: path.join(dir, file) });
  };
  for (const e of await entries(userDir)) {
    if (e.isFile()) add('내 레퍼런스', userDir, e.name, e.name);
    else if (e.isDirectory() && !e.name.startsWith('.')) for (const f of await entries(path.join(userDir, e.name))) if (f.isFile()) add(e.name, path.join(userDir, e.name), f.name, `${e.name}/${f.name}`);
  }
  const order = (c) => (c === 'stageshow · gold' ? 0 : c.startsWith('stageshow') ? 2 : 1);
  return out.sort((a, b) => order(a.category) - order(b.category) || a.category.localeCompare(b.category) || a.title.localeCompare(b.title));
}

async function find(dirs, id) {
  const ref = (await listRefs(dirs)).find((r) => r.id === id);
  if (!ref) throw new HttpError(404, 'reference not found');
  return ref;
}

export async function readRef(dirs, id) {
  const ref = await find(dirs, id);
  return { type: IMAGE[path.extname(ref.path).toLowerCase()], body: await fsp.readFile(ref.path) };
}

export async function resolveReferences(ids, dirs) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids) || ids.length > 4 || !ids.every((id) => typeof id === 'string')) throw new HttpError(400, 'references must be at most 4 ids');
  return Promise.all([...new Set(ids)].map(async (id) => {
    const ref = await find(dirs, id).catch(() => { throw new HttpError(400, `unknown reference: ${id.slice(0, 80)}`); });
    const note = ref.source ? '' : await fsp.readFile(ref.path.replace(/\.[^.]+$/, '.md'), 'utf8').catch(() => '');
    return { ...ref, note: note.trim().slice(0, MAX_NOTE) };
  }));
}

export function formatReferences(refs) {
  const line = (r) => r.source
    ? `- stageshow \`${r.title}\` (${r.category}): ${r.learn || r.need}\n  still: ${r.path}\n  source: ${r.source} — start from this example as the stageshow skill describes`
    : `- ${r.title} (${r.category}, user's own): ${r.path}${r.note ? `\n  note: ${r.note.replace(/\n/g, '\n  ')}` : ''}`;
  return `Design references chosen by the user. Treat them as the visual standard for this work and open the image files:\n${refs.map(line).join('\n')}`;
}
