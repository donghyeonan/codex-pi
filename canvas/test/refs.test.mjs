import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listRefs, readRef, resolveReferences, formatReferences, parseStageshowTables, DEFAULT_REFS } from '../refs.mjs';

test('refs: stageshow stills get SKILL.md metadata; user library by folder with notes; unknown ids rejected', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'refs-'));
  const stillsDir = path.join(root, 'stills'), skillDir = path.join(root, 'skill'), userDir = path.join(root, 'mine');
  await fsp.mkdir(stillsDir); await fsp.mkdir(skillDir); await fsp.mkdir(path.join(userDir, '보고서'), { recursive: true });
  await fsp.writeFile(path.join(skillDir, 'SKILL.md'), '### Gold\n\n| Need | Example | What to learn |\n|---|---|---|\n| Still | `static-card` | Quiet hierarchy |\n\n### Product studies\n\n| Need | Example | Learn |\n|---|---|---|\n| Files | `finder`, `finder-glass` | Quick Look |\n');
  await fsp.writeFile(path.join(stillsDir, 'static-card.jpg'), 'j');
  await fsp.writeFile(path.join(stillsDir, 'finder-glass.jpg'), 'j');
  await fsp.writeFile(path.join(userDir, '보고서', 'velog.png'), 'p');
  await fsp.writeFile(path.join(userDir, '보고서', 'velog.md'), '원문 → 해설 순서');
  await fsp.writeFile(path.join(userDir, 'skip.txt'), 'x');
  const dirs = { stillsDir, skillDir, userDir };
  assert.deepEqual((await listRefs(dirs)).map((r) => [r.id, r.category]), [
    ['stageshow/static-card', 'stageshow · gold'], ['mine/보고서/velog.png', '보고서'], ['stageshow/finder-glass', 'stageshow · 제품']]);
  assert.equal((await readRef(dirs, 'stageshow/static-card')).type, 'image/jpeg');
  const [s, m] = await resolveReferences(['stageshow/static-card', 'mine/보고서/velog.png'], dirs);
  assert.equal(m.note, '원문 → 해설 순서');
  const text = formatReferences([s, m]);
  assert.match(text, /stageshow `static-card` \(stageshow · gold\): Quiet hierarchy/);
  assert.match(text, new RegExp(`source: ${path.join(skillDir, 'examples', 'static-card').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(text, /note: 원문/);
  await assert.rejects(readRef(dirs, '../etc/passwd'), { status: 404 });
  await assert.rejects(resolveReferences(['mine/skip.txt'], dirs), { status: 400 });
  await assert.rejects(resolveReferences(['a', 'b', 'c', 'd', 'e'], dirs), { status: 400 });
});

test('refs: bundled stageshow skill tables cover the bundled stills', async () => {
  const meta = parseStageshowTables(await fsp.readFile(path.join(DEFAULT_REFS.skillDir, 'SKILL.md'), 'utf8'));
  assert.ok(meta.get('static-card')?.category === 'stageshow · gold');
  const stills = (await fsp.readdir(DEFAULT_REFS.stillsDir).catch(() => [])).map((f) => path.basename(f, '.jpg'));
  assert.ok(stills.length > 0, 'bundled stills present');
  for (const id of stills) assert.ok(meta.has(id), `${id} described in SKILL.md`);
});
