import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../../../..');
const dir = path.join(root, '.codex');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'hooks.json');
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
config.hooks ??= {};
const command = 'node "$(git rev-parse --show-toplevel)/.agents/skills/problem-ledger/scripts/context-hook.mjs"';
for (const event of ['SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
  config.hooks[event] ??= [];
  if (!config.hooks[event].some(group => group.hooks?.some(hook => hook.command === command)))
    config.hooks[event].push({ hooks: [{ type: 'command', command, timeout: 3 }] });
}
fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
const ignore = path.join(dir, '.gitignore');
const old = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
if (!old.split('\n').includes('.context-state/')) fs.writeFileSync(ignore, old + '\n.context-state/\n');
console.log('Installed context reminder hooks. In Codex, review and trust them with /hooks. Requires a git workspace and Codex hook support.');
