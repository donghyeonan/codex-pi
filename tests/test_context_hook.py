import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('context_hook', Path(__file__).resolve().parents[1] / 'context_hook.py')
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


class ContextHookTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.log = self.root / 'rollout.jsonl'
        (self.root / '.codex-pi').mkdir()
        self.config = self.root / '.codex-pi/config.json'
        self.config.write_text(json.dumps({'context_ratio': .8}))
        self.event = {'cwd': str(self.root), 'session_id': 'test-session',
                      'hook_event_name': 'Stop', 'transcript_path': str(self.log)}

    def token(self, used, window=1000, cumulative=999999):
        return {'type': 'event_msg', 'payload': {'type': 'token_count', 'info': {
            'last_token_usage': {'total_tokens': used},
            'total_token_usage': {'total_tokens': cumulative}, 'model_context_window': window}}}

    def save(self, *events):
        self.log.write_text('\n'.join(json.dumps(e) for e in events))

    def test_below_threshold_silent_even_with_large_cumulative_usage(self):
        self.save(self.token(799))
        self.assertEqual(hook.handle(self.event), {})

    def test_at_threshold_one_continuation_and_no_repeat(self):
        self.save(self.token(800))
        out = hook.handle(self.event)
        self.assertEqual(out['decision'], 'block')
        self.assertIn('handoff prepare', out['reason'])
        self.assertIn('/new', out['reason'])
        self.assertEqual(hook.handle(self.event), {})

    def test_no_infinite_stop_loop(self):
        self.save(self.token(900))
        self.event['stop_hook_active'] = True
        self.assertEqual(hook.handle(self.event), {})

    def test_unknown_window_never_guessed(self):
        self.save(self.token(900, None))
        self.assertIsNone(hook.usage_from_transcript(self.log))
        self.assertEqual(hook.handle(self.event), {})

    def test_old_usage_after_compaction_not_reused(self):
        self.save(self.token(900), {'type': 'compacted', 'payload': {}})
        self.assertIsNone(hook.usage_from_transcript(self.log))
        self.save(self.token(900), {'type': 'compacted'}, self.token(100))
        self.assertEqual(hook.usage_from_transcript(self.log)['used'], 100)

    def test_no_activation_without_configured_threshold(self):
        self.save(self.token(900))
        self.config.write_text('{}')
        self.assertEqual(hook.handle(self.event), {})

    def test_cap_and_ratio_use_earlier_boundary(self):
        self.assertEqual(hook.threshold({'window': 1000}, {'context_ratio': .8, 'context_tokens': 500}), 500)
        for ratio in (0, 1, True, float('nan'), float('inf')):
            with self.assertRaises(ValueError):
                hook.limits({'context_ratio': ratio})

    def test_operating_cap_does_not_override_smaller_real_window(self):
        config = {'context_ratio': .8, 'context_window_cap': 512000}
        self.assertEqual(hook.threshold({'window': 1050000}, config), 409600)
        self.assertEqual(hook.threshold({'window': 486400}, config), 389120)
        with self.assertRaises(ValueError):
            hook.limits({'context_window_cap': -1})

    def test_sessions_independent(self):
        self.save(self.token(900))
        hook.handle(self.event)
        self.event['session_id'] = 'other-session'
        self.assertEqual(hook.handle(self.event)['decision'], 'block')

    def test_session_start_does_not_inject_unselected_notes(self):
        self.event['hook_event_name'] = 'SessionStart'
        out = hook.handle(self.event)['hookSpecificOutput']['additionalContext']
        self.assertIn('If more than one, ask which', out)
        self.assertIn('Saving notes alone is not', out)

    def test_state_symlink_rejected(self):
        self.save(self.token(900))
        external = self.root / 'outside'
        external.mkdir()
        (self.root / '.codex-pi/hooks').symlink_to(external)
        with self.assertRaises(ValueError):
            hook.handle(self.event)

    def test_transcript_symlink_not_read(self):
        self.save(self.token(900))
        link = self.root / 'link.jsonl'
        link.symlink_to(self.log)
        self.assertIsNone(hook.usage_from_transcript(link))


if __name__ == '__main__':
    unittest.main()
