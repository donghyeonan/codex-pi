import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('setup_workspace', Path(__file__).resolve().parents[1] / 'setup_workspace.py')
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / 'empty workspace'
        self.root.mkdir()

    def test_empty_install_and_repeat(self):
        result = setup.install(self.root, .8)
        self.assertEqual(result['context_window_cap'], 512000)
        self.assertEqual(len((self.root / 'AGENTS.md').read_text().splitlines()), 3)
        for name in ['grilling', 'grill-me', 'codex-pi']:
            self.assertTrue((self.root / '.agents/skills' / name / 'SKILL.md').exists())
        setup.install(self.root, .8)
        hooks = json.loads((self.root / '.codex/hooks.json').read_text())
        self.assertEqual(len(hooks['hooks']['Stop']), 1)
        self.assertEqual(len(hooks['hooks']['SessionStart']), 1)
        self.assertNotIn('__KIT__', (self.root / '.agents/skills/codex-pi/SKILL.md').read_text())

    def test_preserves_existing_settings_and_instructions(self):
        (self.root / '.codex').mkdir()
        config = self.root / '.codex/config.toml'
        config.write_text('model = "provided-model"\n')
        (self.root / 'AGENTS.md').write_text('Existing instructions.\n')
        h = {'hooks': {'Stop': [{'hooks': [{'type': 'command', 'command': 'echo existing'}]}]}}
        (self.root / '.codex/hooks.json').write_text(json.dumps(h))
        setup.install(self.root, .8)
        self.assertEqual(config.read_text(), 'model = "provided-model"\n')
        self.assertTrue((self.root / 'AGENTS.md').read_text().startswith('Existing instructions.\n'))
        installed = json.loads((self.root / '.codex/hooks.json').read_text())
        self.assertEqual(installed['hooks']['Stop'][0], h['hooks']['Stop'][0])

    def test_refuses_foreign_skill_without_partial_install(self):
        p = self.root / '.agents/skills/grill-me/SKILL.md'
        p.parent.mkdir(parents=True)
        p.write_text('my skill')
        with self.assertRaises(ValueError):
            setup.install(self.root, .8)
        self.assertEqual(p.read_text(), 'my skill')
        self.assertFalse((self.root / '.codex').exists())
        self.assertFalse((self.root / 'AGENTS.md').exists())

    def test_refuses_symlink_and_invalid_ratio(self):
        external = Path(self.tmp.name) / 'external'
        external.mkdir()
        (self.root / '.agents').symlink_to(external)
        with self.assertRaises(ValueError):
            setup.install(self.root, .8)
        self.assertEqual(list(external.iterdir()), [])
        for ratio in [0, 1, float('nan'), float('inf')]:
            with self.assertRaises(ValueError):
                setup.install(self.root, ratio)


if __name__ == '__main__':
    unittest.main()
