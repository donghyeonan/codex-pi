#!/usr/bin/env python3
"""Install project-local skills/hooks. Never changes user/system Codex settings."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shlex
import tempfile

KIT = Path(__file__).resolve().parent
MARKER = 'codex-pi-local'
AGENT_BLOCK = ('<!-- codex-pi:start -->\n'
               'For task checkpoints, explicit resume requests, local session history, tickets and verification, read `.agents/skills/codex-pi/SKILL.md`; saving notes alone never requests /new.\n'
               '<!-- codex-pi:end -->')


def checked(root, relative):
    p = root
    for part in Path(relative).parts:
        if part in ('..', '/'):
            raise ValueError('unsafe installation path')
        p = p / part
        if p.is_symlink():
            raise ValueError(f'refusing symlink: {p}')
    return p


def atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.codex-pi-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def digest(b):
    return hashlib.sha256(b).hexdigest()


def install(root, ratio, window_cap=512000):
    if not 0 < ratio < 1 or window_cap < 1:
        raise ValueError('ratio must be between 0 and 1; window cap must be positive')
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError('workspace is not a directory')
    manifest = checked(root, '.codex-pi/install.json')
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    writes = {}
    owned = {}
    for name in ('codex-pi', 'grill-me', 'grilling'):
        rel = f'.agents/skills/{name}/SKILL.md'
        path = checked(root, rel)
        source = (KIT / 'skills' / name / 'SKILL.md').read_text()
        content = source.replace('__KIT__', shlex.quote(str(KIT))).encode()
        if path.exists() and path.read_bytes() != content:
            if previous.get('owned', {}).get(rel) != digest(path.read_bytes()):
                raise ValueError(f'existing skill is not ours or was edited: {path}')
        writes[rel] = content
        owned[rel] = digest(content)
    rel = '.agents/skills/grilling/LICENSE'
    path = checked(root, rel)
    license_bytes = (KIT / 'third-party/mattpocock-LICENSE').read_bytes()
    if path.exists() and path.read_bytes() != license_bytes:
        raise ValueError('existing third-party license differs')
    writes[rel] = license_bytes
    hooks_path = checked(root, '.codex/hooks.json')
    hooks = json.loads(hooks_path.read_text()) if hooks_path.exists() else {}
    if not isinstance(hooks, dict) or not isinstance(hooks.get('hooks', {}), dict):
        raise ValueError('existing hooks configuration is not an object')
    groups = hooks.setdefault('hooks', {})
    command = f'python3 {shlex.quote(str(KIT / "context_hook.py"))}'
    for event in ('SessionStart', 'Stop'):
        old = groups.get(event, [])
        if not isinstance(old, list):
            raise ValueError('existing hook event must be a list')
        kept = []
        for existing in old:
            if not isinstance(existing, dict) or not isinstance(existing.get('hooks'), list):
                raise ValueError('invalid existing hook group')
            handlers = [h for h in existing['hooks'] if h.get('statusMessage') != MARKER]
            if handlers:
                kept.append(dict(existing, hooks=handlers))
        groups[event] = kept
        group = {'hooks': [{'type': 'command', 'command': command, 'timeout': 10, 'statusMessage': MARKER}]}
        if event == 'SessionStart':
            group['matcher'] = 'startup|resume|clear|compact'
        groups[event].append(group)
    writes['.codex/hooks.json'] = (json.dumps(hooks, indent=2) + '\n').encode()
    agents_path = checked(root, 'AGENTS.md')
    agents = agents_path.read_text() if agents_path.exists() else ''
    start, end = '<!-- codex-pi:start -->', '<!-- codex-pi:end -->'
    if start in agents or end in agents:
        if agents.count(start) != 1 or agents.count(end) != 1 or agents.index(start) > agents.index(end):
            raise ValueError('ambiguous codex-pi AGENTS block')
        a, b = agents.index(start), agents.index(end) + len(end)
        agents = agents[:a] + AGENT_BLOCK + agents[b:]
    else:
        agents = agents.rstrip() + ('\n\n' if agents.strip() else '') + AGENT_BLOCK + '\n'
    writes['AGENTS.md'] = agents.encode()
    config_path = checked(root, '.codex-pi/config.json')
    config = json.loads(config_path.read_text()) if config_path.exists() else {}
    config.update(context_ratio=ratio, context_window_cap=window_cap)
    writes['.codex-pi/config.json'] = (json.dumps(config, indent=2) + '\n').encode()
    ignore = checked(root, '.codex-pi/.gitignore')
    if not ignore.exists():
        writes['.codex-pi/.gitignore'] = b'*\n'
    # Preflight every destination before any writes. Keep local backups, not public artifacts.
    for rel in writes:
        dest = checked(root, rel)
        if dest.exists() and not dest.is_file():
            raise ValueError(f'not a regular file: {dest}')
    backup = checked(root, '.codex-pi/install-backups/' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    backup.mkdir(parents=True, mode=0o700)
    old = {}
    for rel, content in writes.items():
        dest = checked(root, rel)
        old[rel] = dest.exists()
        if dest.exists():
            atomic(backup / rel, dest.read_bytes())
        atomic(dest, content)
    atomic(backup / 'files.json', (json.dumps(old, indent=2) + '\n').encode())
    atomic(manifest, (json.dumps({'kit': str(KIT), 'owned': owned, 'backup': str(backup)}, indent=2) + '\n').encode())
    return {'workspace': str(root), 'kit': str(KIT), 'context_ratio': ratio,
            'context_window_cap': window_cap, 'backup': str(backup),
            'next': 'Open the provided codex in this workspace, review project trust and /hooks. Trust only these reviewed hooks. Then start a new conversation. No trust bypass is used.'}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root', required=True)
    ap.add_argument('--ratio', type=float, required=True, help='explicit checkpoint threshold ratio, e.g. 0.8')
    ap.add_argument('--window-cap', type=int, default=512000)
    args = ap.parse_args()
    try:
        print(json.dumps(install(args.root, args.ratio, args.window_cap), indent=2))
    except (ValueError, OSError, TypeError) as e:
        ap.exit(1, f'Installation stopped: {e}\n')


if __name__ == '__main__':
    main()
