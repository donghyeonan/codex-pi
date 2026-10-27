import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "codex_pi.py")
sys.path.insert(0, os.path.dirname(HERE))
import codex_pi as cp  # noqa: E402

NOTES = {"goal": "Ship kit", "constraints": ["stdlib only"], "decisions": ["use JSONL"],
         "progress": "half", "next": "write tests", "references": ["codex_pi.py"]}


def run_cli(*args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = cp.main(list(args))
    return code, out.getvalue(), err.getvalue()


def jl(*records):
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)


def ri(payload, ts="2026-01-01T00:00:00Z"):
    return {"timestamp": ts, "type": "response_item", "payload": payload}


def ev(payload):
    return {"timestamp": "2026-01-01T00:00:00Z", "type": "event_msg", "payload": payload}


class Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self._tmp.name, "ws")
        os.mkdir(self.root)

    def tearDown(self):
        self._tmp.cleanup()

    def notes_file(self, data=NOTES, name="n.json"):
        p = os.path.join(self._tmp.name, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        return p


class NotesTest(Base):
    def test_save_creates_immutable_history_and_latest(self):
        code, out, _ = run_cli("--root", self.root, "notes", "save", "--session", "s1",
                               "--file", self.notes_file())
        self.assertEqual(code, 0)
        first = json.loads(out)
        self.assertEqual(first["revision"], 1)
        changed = dict(NOTES, progress="more")
        code, out, _ = run_cli("--root", self.root, "notes", "save", "--session", "s1",
                               "--file", self.notes_file(changed, "m.json"))
        self.assertEqual(json.loads(out)["revision"], 2)
        hist = os.path.join(self.root, ".codex-pi", "notes", "s1", "history")
        files = sorted(os.listdir(hist))
        self.assertEqual(len(files), 4)  # r1 json+md, r2 json+md
        r1 = os.path.join(hist, files[0])
        self.assertEqual(os.stat(r1).st_mode & 0o777, 0o400, "history must be 0400")
        for d in (".codex-pi", ".codex-pi/notes", ".codex-pi/notes/s1/history"):
            self.assertEqual(os.stat(os.path.join(self.root, d)).st_mode & 0o777, 0o700, d)
        latest = os.path.join(self.root, ".codex-pi", "notes", "s1", "latest.json")
        self.assertEqual(os.stat(latest).st_mode & 0o777, 0o600)
        with self.assertRaises(FileExistsError):
            cp.write_immutable(r1, "x")
        self.assertEqual(cp.read_notes(self.root, "s1", 1)["notes"]["progress"], "half")
        self.assertEqual(cp.read_notes(self.root, "s1")["notes"]["progress"], "more")
        with open(os.path.join(self.root, ".codex-pi", "notes", "s1", "latest.md")) as f:
            self.assertIn("revision 2", f.read())
        code, out, _ = run_cli("--root", self.root, "notes", "read", "--session", "s1")
        self.assertEqual(code, 0)
        self.assertIn("## Progress\nmore", out)
        # saving does not create a handoff
        self.assertEqual(cp.list_handoffs(self.root), [])
        with open(os.path.join(self.root, ".codex-pi", ".gitignore")) as f:
            self.assertIn("*", f.read())

    def test_validation(self):
        bad = [dict(NOTES, goal=1), {k: v for k, v in NOTES.items() if k != "next"},
               dict(NOTES, extra="x"), dict(NOTES, constraints=[1]), "not json",
               dict(NOTES, progress="가" * 9000)]  # 27000 UTF-8 bytes > 24000
        for i, data in enumerate(bad):
            code, _, err = run_cli("--root", self.root, "notes", "save", "--session", "s",
                                   "--file", self.notes_file(data, f"b{i}.json"))
            self.assertEqual(code, 3, (data if isinstance(data, str) else list(data), err))
        self.assertFalse(os.path.exists(os.path.join(self.root, ".codex-pi", "notes", "s",
                                                     "latest.json")))

    def test_size_limit_is_exactly_24000_bytes(self):
        self.assertEqual(cp.NOTES_MAX_BYTES, 24000)
        base = len(json.dumps(dict(NOTES, progress="")).encode("utf-8"))
        exact = json.dumps(dict(NOTES, progress="x" * (24000 - base)))
        self.assertEqual(len(exact.encode("utf-8")), 24000)
        code, _, err = run_cli("--root", self.root, "notes", "save", "--session", "s",
                               "--file", self.notes_file(exact, "exact.json"))
        self.assertEqual(code, 0, err)
        over = json.dumps(dict(NOTES, progress="x" * (24001 - base)))
        code, _, err = run_cli("--root", self.root, "notes", "save", "--session", "s",
                               "--file", self.notes_file(over, "over.json"))
        self.assertEqual(code, 3)
        self.assertIn("24000", err)

    def test_session_id_traversal_rejected(self):
        for sid in ("../evil", "a/b", "..", ".hidden", "a..b", "", "ok\n"):
            code, _, _ = run_cli("--root", self.root, "notes", "save", "--session", sid,
                                 "--file", self.notes_file())
            self.assertEqual(code, 3, sid)
        self.assertFalse(os.path.exists(os.path.join(self._tmp.name, "evil")))

    def test_symlinked_state_dir_refused(self):
        other = os.path.join(self._tmp.name, "other")
        os.mkdir(other)
        os.symlink(other, os.path.join(self.root, ".codex-pi"))
        code, _, err = run_cli("--root", self.root, "notes", "save", "--session", "s",
                               "--file", self.notes_file())
        self.assertEqual(code, 3, err)
        self.assertEqual(os.listdir(other), [])


class StateHardeningTest(Base):
    def outside(self, text="OUTSIDE"):
        p = os.path.join(self._tmp.name, "outside.txt")
        with open(p, "w") as f:
            f.write(text)
        return p

    def test_symlinked_lock_refused_target_untouched(self):
        target = self.outside()
        locks = cp.state_dir(self.root, "locks")
        os.symlink(target, os.path.join(locks, "tickets.lock"))
        code, _, err = run_cli("--root", self.root, "ticket", "open", "--title", "t",
                               "--problem", "p")
        self.assertEqual(code, 3, err)
        self.assertIn("symlink", err)
        with open(target) as f:
            self.assertEqual(f.read(), "OUTSIDE")

    def test_symlinked_state_leaves_refused_on_read(self):
        cp.save_notes(self.root, "s", json.dumps(NOTES))
        cp.prepare_handoff(self.root, "s")
        cp.ticket_open(self.root, "t", "p")
        target = self.outside(json.dumps(dict(NOTES, goal="EVIL")))
        hist = os.path.join(self.root, ".codex-pi", "notes", "s", "history")
        rev = [n for n in os.listdir(hist) if n.endswith(".json")][0]
        os.chmod(hist, 0o700)
        os.unlink(os.path.join(hist, rev))
        os.symlink(target, os.path.join(hist, rev))
        code, out, err = run_cli("--root", self.root, "notes", "read", "--session", "s")
        self.assertEqual(code, 3, err)
        self.assertNotIn("EVIL", out)
        hpath = os.path.join(self.root, ".codex-pi", "handoffs", "H0001.json")
        os.unlink(hpath)
        os.symlink(target, hpath)
        self.assertEqual(run_cli("--root", self.root, "handoff", "list")[0], 3)
        tpath = os.path.join(self.root, ".codex-pi", "tickets", "001.md")
        os.unlink(tpath)
        os.symlink(target, tpath)
        code, out, _ = run_cli("--root", self.root, "ticket", "read", "--id", "1")
        self.assertEqual(code, 3)
        self.assertNotIn("EVIL", out)
        self.assertEqual(run_cli("--root", self.root, "ticket", "trial", "--id", "1",
                                 "--approach", "a", "--result", "r", "--outcome", "failed")[0], 3)
        with open(target) as f:
            self.assertIn("EVIL", f.read())  # never written through

    def test_write_atomic_replaces_symlink_not_target(self):
        target = self.outside()
        d = cp.state_dir(self.root, "handoffs")
        link = os.path.join(d, "x.json")
        os.symlink(target, link)
        cp.write_atomic(link, "{}")
        self.assertFalse(os.path.islink(link))
        self.assertEqual(os.stat(link).st_mode & 0o777, 0o600)
        with open(target) as f:
            self.assertEqual(f.read(), "OUTSIDE")
        self.assertEqual([n for n in os.listdir(d) if ".tmp" in n], [])
        with self.assertRaises(cp.CodexPiError):
            os.symlink(target, os.path.join(d, "y.json"))
            cp.write_immutable(os.path.join(d, "y.json"), "x")

    def test_nan_lock_timeout_rejected_not_hung(self):
        os.environ["CODEX_PI_LOCK_TIMEOUT"] = "nan"
        try:
            code, _, err = run_cli("--root", self.root, "ticket", "open", "--title", "t",
                                   "--problem", "p")
        finally:
            del os.environ["CODEX_PI_LOCK_TIMEOUT"]
        self.assertEqual(code, 3, err)
        self.assertIn("lock timeout", err)


class HandoffTest(Base):
    def save(self, sid, **kw):
        cp.save_notes(self.root, sid, json.dumps(dict(NOTES, **kw)))

    def test_prepare_read_consume(self):
        self.save("old")
        tpath = os.path.join(self._tmp.name, "rollout.jsonl")
        with open(tpath, "w") as f:
            f.write(jl(ri({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]})))
        cp.register_transcript(self.root, "old", tpath)
        self.save("old", progress="later")  # pinning happens at prepare, not save
        code, out, _ = run_cli("--root", self.root, "handoff", "prepare", "--session", "old")
        self.assertEqual(code, 0)
        h = json.loads(out)
        self.assertEqual((h["id"], h["notes_revision"], h["status"]), ("H0001", 2, "pending"))
        self.assertEqual(h["transcript"]["path"], os.path.realpath(tpath))
        self.assertEqual(h["transcript"]["line_count"], 1)
        self.assertIn("cannot be detected", h["warning"])
        # consume before read is refused
        self.assertEqual(run_cli("--root", self.root, "handoff", "consume", "--id", "H0001",
                                 "--session", "new")[0], 3)
        self.save("old", progress="after-prepare")
        # newer notes after prepare: pending handoff is stale -> rejected, re-prepare required
        code, out, err = run_cli("--root", self.root, "handoff", "read")
        self.assertEqual((code, out), (3, ""))
        self.assertIn("stale", err)
        self.assertIn("handoff prepare --session old", err)
        # the pinned historical revision is still readable directly
        code, out, _ = run_cli("--root", self.root, "notes", "read", "--session", "old",
                               "--revision", "2")
        self.assertEqual(code, 0)
        self.assertIn("## Progress\nlater", out)
        self.assertEqual(run_cli("--root", self.root, "handoff", "prepare", "--session", "old")[0], 0)
        st = {x["id"]: x["status"] for x in cp.list_handoffs(self.root)}
        self.assertEqual(st, {"H0001": "superseded", "H0002": "pending"})
        code, out, _ = run_cli("--root", self.root, "handoff", "read")
        self.assertEqual(code, 0)
        self.assertIn("## Progress\nafter-prepare", out)
        self.assertIn("handoff consume --id H0002", out)
        self.assertIn("Warning: Freshness guard", out)
        # the source session cannot consume its own handoff
        code, _, err = run_cli("--root", self.root, "handoff", "consume", "--id", "H0002",
                               "--session", "old")
        self.assertEqual(code, 3)
        self.assertIn("source session", err)
        code, out, _ = run_cli("--root", self.root, "handoff", "consume", "--id", "H0002",
                               "--session", "new")
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["consumed_by"], "new")
        self.assertEqual(run_cli("--root", self.root, "handoff", "consume", "--id", "H0002",
                                 "--session", "new")[0], 3)
        self.assertEqual(run_cli("--root", self.root, "handoff", "read")[0], 3)  # none pending
        # consumed handoffs stay readable by id as history even after newer notes
        self.save("old", progress="even-later")
        code, out, _ = run_cli("--root", self.root, "handoff", "read", "--id", "H0002")
        self.assertEqual(code, 0)
        self.assertIn("(consumed)", out)

    def test_consume_rejects_notes_saved_after_read(self):
        self.save("a")
        cp.prepare_handoff(self.root, "a")
        cp.read_handoff(self.root, "H0001")
        self.save("a", progress="newer")
        code, _, err = run_cli("--root", self.root, "handoff", "consume", "--id", "H0001",
                               "--session", "b")
        self.assertEqual(code, 3)
        self.assertIn("stale", err)
        self.assertEqual(cp.list_handoffs(self.root)[0]["status"], "pending")

    def test_consume_reverifies_pinned_digest(self):
        self.save("a")
        cp.prepare_handoff(self.root, "a")
        cp.read_handoff(self.root, "H0001")
        hist = os.path.join(self.root, ".codex-pi", "notes", "a", "history")
        rev = os.path.join(hist, [n for n in os.listdir(hist) if n.endswith(".json")][0])
        os.chmod(rev, 0o600)  # tamper with the pinned revision after it was read
        with open(rev) as f:
            body = f.read()
        with open(rev, "w") as f:
            f.write(body.replace("Ship kit", "Tampered"))
        code, _, err = run_cli("--root", self.root, "handoff", "consume", "--id", "H0001",
                               "--session", "b")
        self.assertEqual(code, 3)
        self.assertIn("changed on disk", err)
        self.assertEqual(cp.list_handoffs(self.root)[0]["status"], "pending")

    def test_register_transcript_refuses_symlink_escape_and_non_transcripts(self):
        sroot = os.path.join(self._tmp.name, "sessions")
        os.makedirs(sroot)
        outside = os.path.join(self._tmp.name, "outside")
        os.mkdir(outside)
        real = os.path.join(outside, "rollout-x.jsonl")
        with open(real, "w") as f:
            f.write("{}\n")
        link = os.path.join(sroot, "rollout-link.jsonl")
        os.symlink(real, link)
        code, _, err = run_cli("--root", self.root, "sessions", "register", "--session", "s",
                               "--file", link)
        self.assertEqual(code, 3)
        self.assertIn("symlink", err)
        os.symlink(outside, os.path.join(sroot, "linked"))  # escape via symlinked parent dir
        code, _, err = run_cli("--root", self.root, "sessions", "register", "--session", "s",
                               "--file", os.path.join(sroot, "linked", "rollout-x.jsonl"),
                               "--dir", sroot)
        self.assertEqual(code, 3)
        self.assertIn("outside", err)
        auth = os.path.join(self._tmp.name, "auth.json")
        with open(auth, "w") as f:
            f.write('{"token": "SECRET"}')
        code, out, err = run_cli("--root", self.root, "sessions", "register", "--session", "s",
                                 "--file", auth)
        self.assertEqual(code, 3)
        self.assertNotIn("SECRET", out + err)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".codex-pi", "transcripts", "s.json")))
        inside = os.path.join(sroot, "rollout-ok.jsonl")
        with open(inside, "w") as f:
            f.write("{}\n")
        code, out, err = run_cli("--root", self.root, "sessions", "register", "--session", "s",
                                 "--file", inside, "--dir", sroot)
        self.assertEqual(code, 0, err)
        self.assertEqual(json.loads(out)["path"], os.path.realpath(inside))

    def test_ambiguous_handoff_errors(self):
        self.save("a")
        self.save("b")
        cp.prepare_handoff(self.root, "a")
        cp.prepare_handoff(self.root, "b")
        code, out, err = run_cli("--root", self.root, "handoff", "read")
        self.assertEqual(code, 3)
        self.assertIn("2 pending", err)
        self.assertEqual(out, "")
        code, out, _ = run_cli("--root", self.root, "handoff", "read", "--id", "H0002", "--json")
        self.assertEqual((code, json.loads(out)["source_session"]), (0, "b"))
        self.assertEqual(run_cli("--root", self.root, "handoff", "read", "--id", "../x")[0], 3)

    def test_reprepare_supersedes_same_session(self):
        self.save("a")
        cp.prepare_handoff(self.root, "a")
        cp.prepare_handoff(self.root, "a")
        st = {h["id"]: h["status"] for h in cp.list_handoffs(self.root)}
        self.assertEqual(st, {"H0001": "superseded", "H0002": "pending"})
        self.assertEqual(cp.read_handoff(self.root)["id"], "H0002")

    def test_prepare_without_notes_fails(self):
        self.assertEqual(run_cli("--root", self.root, "handoff", "prepare", "--session", "x")[0], 3)


class TicketTest(Base):
    def test_lifecycle_single_file(self):
        code, out, _ = run_cli("--root", self.root, "ticket", "open", "--title", "Bug",
                               "--problem", "it breaks")
        self.assertEqual((code, json.loads(out)["id"]), (0, 1))
        run_cli("--root", self.root, "ticket", "trial", "--id", "1", "--approach", "A",
                "--result", "no", "--outcome", "failed")
        code, out, _ = run_cli("--root", self.root, "ticket", "resolve", "--id", "1",
                               "--decision", "D", "--evidence", "test X passed")
        self.assertEqual(code, 0)
        self.assertEqual(os.listdir(os.path.join(self.root, ".codex-pi", "tickets")), ["001.md"])
        text = cp.ticket_read(self.root, 1)
        self.assertIn("Status: resolved", text)
        self.assertIn("trial 1: failed", text)
        self.assertIn("not independently verified", text)
        # resolved ticket rejects further updates; bad outcome is a usage error
        self.assertEqual(run_cli("--root", self.root, "ticket", "trial", "--id", "1",
                                 "--approach", "B", "--result", "r", "--outcome", "failed")[0], 3)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
            cp.main(["--root", self.root, "ticket", "trial", "--id", "1", "--approach", "B",
                     "--result", "r", "--outcome", "great"])
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(run_cli("--root", self.root, "ticket", "trial", "--id", "9",
                                 "--approach", "B", "--result", "r", "--outcome", "failed")[0], 3)

    def test_concurrent_open_and_trials(self):
        cp.ticket_open(self.root, "shared", "p")

        def spawn(*a):
            return subprocess.Popen([sys.executable, SCRIPT, "--root", self.root, *a],
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        procs = [spawn("ticket", "open", "--title", f"t{i}", "--problem", "p") for i in range(6)]
        procs += [spawn("ticket", "trial", "--id", "1", "--approach", f"ap{i}", "--result", "r",
                        "--outcome", "running") for i in range(6)]
        results = [(p.wait(timeout=60), p.stdout.read(), p.stderr.read()) for p in procs]
        for p in procs:
            p.stdout.close()
            p.stderr.close()
        self.assertTrue(all(r[0] == 0 for r in results), results)
        ids = sorted(json.loads(r[1])["id"] for r in results[:6])
        self.assertEqual(ids, list(range(2, 8)))
        text = cp.ticket_read(self.root, 1)
        self.assertIn("Trials: 6", text)
        for i in range(6):
            self.assertIn(f"ap{i}", text)
        self.assertEqual(sorted(int(n) for n in [text.count(f"trial {k}:") for k in range(1, 7)]),
                         [1] * 6)

    def test_lock_timeout(self):
        os.environ["CODEX_PI_LOCK_TIMEOUT"] = "0.2"
        try:
            with cp.locked(self.root, "tickets"):
                p = subprocess.run([sys.executable, SCRIPT, "--root", self.root, "ticket", "open",
                                    "--title", "x", "--problem", "p"], capture_output=True,
                                   timeout=30, env=dict(os.environ))
            self.assertEqual(p.returncode, 4, p.stderr)
        finally:
            del os.environ["CODEX_PI_LOCK_TIMEOUT"]


class SessionsTest(Base):
    def setUp(self):
        super().setUp()
        self.sdir = os.path.join(self._tmp.name, "sessions", "2026", "01", "01")
        os.makedirs(self.sdir)

    def write(self, name, text):
        p = os.path.join(self.sdir, name)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
        return p

    def current_format(self):
        user_txt = "정확한 원문  wording\n두 번째 줄"
        return jl(
            {"type": "session_meta", "payload": {"id": "sess-1", "cwd": "/w",
                                                 "creator_account_id": "SECRET-ACCOUNT"}},
            ri({"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "DEV-PROMPT"}]}),
            ri({"type": "message", "role": "user", "id": "u0",
                "content": [{"type": "input_text", "text": "# AGENTS.md instructions"}],
                "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["agents_md.instructions"]}}),
            ri({"type": "message", "role": "user", "id": "u1",
                "content": [{"type": "input_text", "text": user_txt}],
                "internal_chat_message_metadata_passthrough": {"content_item_kinds": ["user.text"]}}),
            ev({"type": "item_completed", "item": {"type": "UserMessage", "id": "x",
                                                   "content": [{"type": "text", "text": user_txt}]}}),
            ev({"type": "user_message", "message": user_txt}),
            ri({"type": "reasoning", "id": "r1", "summary": [], "encrypted_content": "OPAQUE-BLOB"}),
            ri({"type": "custom_tool_call", "id": "c1", "call_id": "call1", "name": "exec",
                "input": "ls -la"}),
            ri({"type": "custom_tool_call_output", "id": "o1", "call_id": "call1",
                "output": [{"type": "input_text", "text": "file.txt"},
                           {"type": "input_image", "image_url": "data:IMAGEDATA"}]}),
            ri({"type": "function_call", "id": "f1", "call_id": "call2", "name": "shell",
                "arguments": "{\"cmd\": \"pwd\"}"}),
            ri({"type": "function_call_output", "call_id": "call2", "output": "/w"}),
            ri({"type": "message", "role": "assistant", "id": "a1", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "Done: needle here"}]}),
            ri({"type": "message", "role": "assistant", "id": "a1", "phase": "final_answer",
                "content": [{"type": "output_text", "text": "Done: needle here"}]}),
            ev({"type": "agent_message", "message": "Done: needle here"}),
            {"type": "token_usage_record", "payload": {"usage": {}}},
        ), user_txt

    def test_read_current_format_no_duplicates_no_opaque(self):
        body, user_txt = self.current_format()
        p = self.write("rollout-a.jsonl", body)
        code, out, _ = run_cli("sessions", "read", "--file", p)
        self.assertEqual(code, 0)
        doc = json.loads(out)
        self.assertEqual(doc["format"], "response_item")
        roles = [e["role"] for e in doc["entries"]]
        self.assertEqual(roles, ["user", "tool_call", "tool_result", "tool_call", "tool_result",
                                 "assistant"])
        self.assertEqual(doc["entries"][0]["text"], user_txt)  # wording preserved
        self.assertEqual(doc["entries"][0]["line"], 4)
        self.assertEqual(doc["entries"][0]["id"], "u1")
        self.assertEqual(doc["entries"][1]["text"], "ls -la")
        self.assertEqual(doc["entries"][2]["omitted_parts"], ["input_image"])
        self.assertEqual(doc["meta"]["id"], "sess-1")
        for secret in ("SECRET-ACCOUNT", "OPAQUE-BLOB", "IMAGEDATA", "DEV-PROMPT", "AGENTS.md"):
            self.assertNotIn(secret, out)
        self.assertEqual(doc["ignored"]["duplicate"], 1)
        # pagination
        page = cp.read_session(p, offset=4, limit=1)
        self.assertEqual([e["entry"] for e in page["entries"]], [4])
        self.assertEqual(page["next_offset"], 5)
        self.assertIsNone(cp.read_session(p, offset=5, limit=1)["next_offset"])
        trunc = cp.read_session(p, limit=1, max_chars=3)["entries"][0]
        self.assertEqual((trunc["text"], trunc["truncated"]), (user_txt[:3], True))

    def test_event_msg_only_fallback_dedups_echo(self):
        p = self.write("rollout-ev.jsonl", jl(
            ev({"type": "user_message", "message": "hello"}),
            ev({"type": "item_completed", "item": {"type": "UserMessage", "id": "i1",
                                                   "content": [{"type": "text", "text": "hello"}]}}),
            ev({"type": "agent_message", "message": "world"}),
            ev({"type": "token_count", "info": {}})))
        doc = cp.read_session(p)
        self.assertEqual(doc["format"], "event_msg")
        self.assertEqual([(e["role"], e["text"]) for e in doc["entries"]],
                         [("user", "hello"), ("assistant", "world")])

    def test_event_msg_fallback_preserves_genuine_repeats(self):
        um = lambda t: ev({"type": "user_message", "message": t})
        am = lambda t: ev({"type": "agent_message", "message": t})
        ic = lambda kind, t: ev({"type": "item_completed", "item": {
            "type": kind, "content": [{"type": "text", "text": t}]}})
        p = self.write("rollout-rep.jsonl", jl(
            um("continue"), ic("UserMessage", "continue"),
            am("ok"), ic("AgentMessage", "ok"),
            um("continue"), ic("UserMessage", "continue"),  # repeat separated by assistant
            ev({"type": "token_count", "info": {}}),
            um("continue"),                                  # back-to-back repeat, same kind
            am("ok"), am("ok")))
        doc = cp.read_session(p)
        self.assertEqual([(e["role"], e["text"]) for e in doc["entries"]],
                         [("user", "continue"), ("assistant", "ok"), ("user", "continue"),
                          ("user", "continue"), ("assistant", "ok"), ("assistant", "ok")])
        self.assertEqual(doc["ignored"]["event_msg_echo"], 3)

    def test_primary_keeps_unmatched_event_messages_in_order(self):
        user = lambda t: ri({"type": "message", "role": "user",
                             "content": [{"type": "input_text", "text": t}]})
        asst = lambda t: ri({"type": "message", "role": "assistant", "phase": "final_answer",
                             "content": [{"type": "output_text", "text": t}]})
        ic = lambda kind, t: ev({"type": "item_completed", "item": {
            "type": kind, "content": [{"type": "Text", "text": t}]}})
        p = self.write("rollout-mix.jsonl", jl(
            user("continue"), ic("UserMessage", "continue"),
            ic("AgentMessage", "ok"), asst("ok"),
            user("continue"), ic("UserMessage", "continue"),
            ri({"type": "custom_tool_call", "call_id": "c", "name": "exec", "input": "ls"}),
            ic("AgentMessage", "progress note only in event stream"),
            ri({"type": "custom_tool_call_output", "call_id": "c", "output": "a.txt"}),
            ev({"type": "agent_message", "message": "done"}), asst("done")))
        doc = cp.read_session(p)
        self.assertEqual(doc["format"], "response_item")
        got = [(e["role"], e["text"], e["source"]) for e in doc["entries"]]
        self.assertEqual(got, [
            ("user", "continue", "response_item"), ("assistant", "ok", "response_item"),
            ("user", "continue", "response_item"), ("tool_call", "ls", "response_item"),
            ("assistant", "progress note only in event stream", "event_msg"),
            ("tool_result", "a.txt", "response_item"), ("assistant", "done", "response_item")])
        self.assertEqual(doc["entries"][1]["phase"], "final_answer")  # canonical record kept
        self.assertEqual(doc["ignored"]["event_msg_echo"], 4)

    def test_reasoning_channels_and_parts_excluded(self):
        p = self.write("rollout-rsn.jsonl", jl(
            ri({"type": "message", "role": "assistant", "channel": "analysis",
                "content": [{"type": "output_text", "text": "HIDDEN-ANALYSIS"}]}),
            ri({"type": "message", "role": "assistant", "phase": "reasoning",
                "content": [{"type": "output_text", "text": "HIDDEN-PHASE"}]}),
            ri({"type": "message", "role": "assistant", "phase": "commentary",
                "content": [{"type": "reasoning_text", "text": "HIDDEN-PART"},
                            {"type": "summary_text", "text": "HIDDEN-SUMMARY"},
                            {"type": "output_text", "text": "visible preamble"}]}),
            ri({"type": "reasoning", "summary": [{"type": "summary_text", "text": "HIDDEN-TOP"}]}),
            ev({"type": "agent_reasoning", "text": "HIDDEN-EVENT"}),
            ev({"type": "item_completed", "item": {"type": "AgentMessage", "phase": "analysis",
                                                   "content": [{"type": "Text", "text": "HIDDEN-ITEM"}]}}),
            {"type": "compacted", "payload": {"message": "HIDDEN-COMPACT-SUMMARY"}}))
        code, out, _ = run_cli("sessions", "read", "--file", p)
        self.assertEqual(code, 0)
        doc = json.loads(out)
        self.assertEqual([e["text"] for e in doc["entries"]], ["visible preamble"])
        self.assertEqual(doc["entries"][0]["omitted_parts"], ["reasoning_text", "summary_text"])
        self.assertNotIn("HIDDEN", out)
        self.assertEqual(doc["ignored"]["message:reasoning-channel"], 2)
        self.assertTrue(any("reasoning" in s for s in doc["omitted_by_design"]))

    def test_page_and_search_limits_validated(self):
        p = self.write("rollout-l.jsonl", jl(ri({"type": "message", "role": "user",
                                                  "content": [{"type": "input_text", "text": "x"}]})))
        sroot = os.path.join(self._tmp.name, "sessions")
        for extra in (["--limit", "0"], ["--limit", "-1"], ["--limit", "1001"],
                      ["--offset", "-1"], ["--max-chars", "-5"], ["--max-chars", "1000001"]):
            code, _, err = run_cli("sessions", "read", "--file", p, *extra)
            self.assertEqual(code, 3, (extra, err))
        for lim in ("0", "-3", "100000"):
            self.assertEqual(run_cli("sessions", "search", "--dir", sroot, "--query", "x",
                                     "--limit", lim)[0], 3, lim)
            self.assertEqual(run_cli("sessions", "list", "--dir", sroot, "--limit", lim)[0], 3, lim)
        self.assertEqual(run_cli("--root", self.root, "notes", "read", "--session", "s",
                                 "--revision", "-1")[0], 3)
        self.assertEqual(run_cli("sessions", "read", "--file", p, "--limit", "1000")[0], 0)
        long_txt = "y" * 30000  # README: `--max-chars 0` rereads untruncated text
        q = self.write("rollout-long.jsonl", jl(ri({"type": "message", "role": "user",
                                                    "content": [{"type": "input_text", "text": long_txt}]})))
        self.assertTrue(cp.read_session(q)["entries"][0]["truncated"])
        code, out, _ = run_cli("sessions", "read", "--file", q, "--max-chars", "0")
        self.assertEqual((code, json.loads(out)["entries"][0]["text"]), (0, long_txt))

    def test_unsupported_reported_not_invented(self):
        p = self.write("rollout-bad.jsonl", "not json\n" + jl({"type": "weird", "x": 1}))
        doc = cp.read_session(p)
        self.assertEqual(doc["format"], "unsupported")
        self.assertEqual(doc["entries"], [])
        self.assertEqual(doc["unsupported_count"], 2)

    def test_list_search_and_symlinks(self):
        body, _ = self.current_format()
        self.write("rollout-a.jsonl", body)
        outside = os.path.join(self._tmp.name, "outside")
        os.mkdir(outside)
        with open(os.path.join(outside, "rollout-x.jsonl"), "w") as f:
            f.write(jl(ri({"type": "message", "role": "user", "content": [{"type": "input_text", "text": "needle outside"}]})))
        os.symlink(outside, os.path.join(self.sdir, "linked-dir"))
        os.symlink(os.path.join(outside, "rollout-x.jsonl"), os.path.join(self.sdir, "link.jsonl"))
        sroot = os.path.join(self._tmp.name, "sessions")
        code, out, _ = run_cli("sessions", "list", "--dir", sroot)
        self.assertEqual(code, 0)
        listed = json.loads(out)
        self.assertEqual(listed["total"], 1)
        self.assertEqual(listed["sessions"][0]["meta"]["id"], "sess-1")
        self.assertNotIn("SECRET-ACCOUNT", out)
        code, out, _ = run_cli("sessions", "search", "--dir", sroot, "--query", "NEEDLE")
        res = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(len(res["matches"]), 1)  # duplicate assistant message & echo dropped
        self.assertEqual(res["matches"][0]["snippet"], "Done: needle here")
        self.assertNotIn("outside", res["matches"][0]["snippet"])
        self.assertEqual(len(cp.search_sessions("e", sroot, limit=2)["matches"]), 2)
        # symlinked file pointing outside the selected root is refused
        code, _, err = run_cli("sessions", "read", "--file", os.path.join(self.sdir, "link.jsonl"),
                               "--dir", sroot)
        self.assertEqual(code, 3, err)
        code, _, _ = run_cli("sessions", "read", "--file", os.path.join(self.sdir, "link.jsonl"))
        self.assertEqual(code, 3)
        self.assertEqual(run_cli("sessions", "list", "--dir",
                                 os.path.join(self._tmp.name, "missing"))[0], 3)


class VerifyTest(Base):
    def verify(self, *argv, timeout="20"):
        code, out, err = run_cli("--root", self.root, "verify", "--timeout", timeout, "--", *argv)
        return code, json.loads(out) if out else None, err

    def test_success_receipt(self):
        code, r, _ = self.verify(sys.executable, "-c", "print('ok'); import sys; sys.stderr.write('e')")
        self.assertEqual(code, 0)
        self.assertEqual((r["status"], r["exit_code"], r["success"]), ("passed", 0, True))
        self.assertEqual(r["stdout_tail"], "ok\n")
        self.assertEqual(r["stderr_tail"], "e")
        self.assertEqual(r["argv"][0], sys.executable)
        self.assertFalse(r["state_changed"])
        self.assertEqual(r["pre"]["kind"], "fs")
        self.assertIn("does not establish", r["note"])
        lim = r["snapshot_limitations"]
        self.assertFalse(lim["complete_revision_record"])
        self.assertIn("does not establish which complete revision", lim["note"])
        self.assertIn("size+mtime only", lim["metadata_only_rule"])
        self.assertEqual((lim["snapshot_truncated"], lim["changes_truncated"]), (False, False))
        with open(r["stdout_log"]) as f:
            self.assertEqual(f.read(), "ok\n")
        self.assertTrue(os.path.isfile(r["receipt"]))
        self.assertEqual(os.stat(r["receipt"]).st_mode & 0o777, 0o400)
        self.assertEqual(r["id"], "V0001")

    def test_invalid_timeouts_rejected_without_running(self):
        marker = os.path.join(self._tmp.name, "ran")
        for t in ("nan", "inf", "-inf", "0", "-1", "86401"):
            code, out, err = run_cli("--root", self.root, "verify", f"--timeout={t}", "--",
                                     sys.executable, "-c", f"open({marker!r},'w')")
            self.assertEqual((code, out), (3, ""), (t, err))
            self.assertIn("timeout must be finite", err)
        self.assertFalse(os.path.exists(marker))
        with self.assertRaises(cp.CodexPiError):
            cp.run_verify(self.root, ["true"], float("nan"))

    def test_receipt_reports_metadata_only_and_truncation(self):
        for n in ("a.txt", "b.txt", "c.txt"):
            with open(os.path.join(self.root, n), "w") as f:
                f.write("0123456789abcdef")
        saved = (cp.MAX_HASH_BYTES, cp.SNAPSHOT_MAX_FILES)
        cp.MAX_HASH_BYTES, cp.SNAPSHOT_MAX_FILES = 8, 2
        try:
            code, r, _ = self.verify(sys.executable, "-c", "pass")
        finally:
            cp.MAX_HASH_BYTES, cp.SNAPSHOT_MAX_FILES = saved
        self.assertEqual(code, 0)
        lim = r["snapshot_limitations"]
        self.assertEqual(lim["metadata_only_paths"], ["a.txt", "b.txt"])
        self.assertTrue(lim["snapshot_truncated"])
        self.assertEqual(lim["snapshot_file_cap"], 2)
        self.assertTrue(r["pre"]["truncated"])

    def test_failure_and_state_change(self):
        code, r, _ = self.verify(sys.executable, "-c",
                                 "open('made.txt','w').write('x'); raise SystemExit(3)")
        self.assertEqual(code, 1)
        self.assertEqual((r["status"], r["exit_code"], r["success"]), ("failed", 3, False))
        self.assertTrue(r["state_changed"])
        self.assertIn("file:made.txt", r["changes"])

    def test_no_shell(self):
        code, r, _ = self.verify("echo", "$HOME;", "&&", "false")
        self.assertEqual(code, 0)
        self.assertEqual(r["stdout_tail"], "$HOME; && false\n")

    def test_spawn_error(self):
        code, r, _ = self.verify("/nonexistent/definitely-not-here")
        self.assertEqual((code, r["status"], r["success"]), (127, "error", False))

    def test_timeout_kills_process_group(self):
        marker = os.path.join(self._tmp.name, "child-alive")
        child = (f"import time; time.sleep(1.5); open({marker!r},'w').write('alive')")
        script = (f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]);"
                  "print('started', flush=True); time.sleep(30)")
        t0 = time.monotonic()
        code, r, _ = self.verify(sys.executable, "-c", script, timeout="0.7")
        self.assertLess(time.monotonic() - t0, 10)
        self.assertEqual(code, 124)
        self.assertEqual((r["status"], r["success"]), ("timeout", False))
        self.assertIn("started", r["stdout_tail"])
        time.sleep(2.0)
        self.assertFalse(os.path.exists(marker), "descendant survived timeout kill")

    def test_background_descendant_killed_after_exit(self):
        marker = os.path.join(self._tmp.name, "bg-alive")
        child = f"import time; time.sleep(1.5); open({marker!r},'w').write('alive')"
        script = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}])"
        code, r, _ = self.verify(sys.executable, "-c", script)
        self.assertEqual(code, 0)
        self.assertTrue(r["descendants_killed_after_exit"])
        time.sleep(2.0)
        self.assertFalse(os.path.exists(marker))

    @unittest.skipUnless(shutil.which("git"), "git not installed")
    def test_git_snapshot(self):
        env = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
        g = lambda *a: subprocess.run(["git", "-C", self.root, *a], check=True, env=env,
                                      capture_output=True)
        g("init", "-q")
        with open(os.path.join(self.root, "a.txt"), "w") as f:
            f.write("1")
        g("add", "a.txt")
        g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
        code, r, _ = self.verify(sys.executable, "-c", "pass")
        self.assertEqual(code, 0)
        self.assertEqual(r["pre"]["kind"], "git")
        self.assertEqual(len(r["pre"]["head"]), 40)
        self.assertFalse(r["pre"]["dirty"])
        self.assertFalse(r["state_changed"])  # .codex-pi logs are excluded
        code, r, _ = self.verify(sys.executable, "-c",
                                 "open('a.txt','w').write('2'); open('new.txt','w').write('n')")
        self.assertTrue(r["state_changed"])
        self.assertIn("dirty_diff_sha256", r["changes"])
        self.assertIn("untracked:new.txt", r["changes"])
        self.assertIn("new.txt", r["post"]["untracked"])
        self.assertFalse(any(".codex-pi" in k for k in r["post"]["untracked"]))
        # git-ignored files are outside the snapshot; the receipt says so explicitly
        os.makedirs(os.path.join(self.root, ".git", "info"), exist_ok=True)
        with open(os.path.join(self.root, ".git", "info", "exclude"), "a") as f:
            f.write("build/\n")
        code, r, _ = self.verify(sys.executable, "-c",
                                 "import os; os.makedirs('build'); open('build/out.bin','w').write('x')")
        self.assertEqual(code, 0)
        self.assertFalse(r["state_changed"])
        self.assertTrue(any("ignored by git" in x for x in r["snapshot_limitations"]["excluded"]))
        self.assertEqual(r["snapshot_limitations"]["errors"], [])

    def test_missing_command_usage(self):
        code, _, err = run_cli("--root", self.root, "verify", "--timeout", "5", "--")
        self.assertEqual(code, 3, err)


if __name__ == "__main__":
    unittest.main()
