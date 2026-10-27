#!/usr/bin/env python3
"""codex-pi: local checkpoint notes, handoffs, tickets, Codex session reading, and
command verification receipts for Codex CLI. Stdlib only, local only, no network.

Usage: python3 codex_pi.py --root WORKSPACE <command> ...
State lives in WORKSPACE/.codex-pi (self-ignored via .codex-pi/.gitignore).

Exit codes: 0 ok; 1 verified command failed; 2 usage error (argparse);
3 validation/state error (not found, ambiguous, invalid input, unsafe path);
4 lock timeout; 124 verified command timed out; 127 verified command could not start.

State hardening: directories 0700, mutable files written via mkstemp(0600)+fsync+replace,
immutable history 0400, locks and state reads refuse symlinked leaves (O_NOFOLLOW).
"""
import argparse
import contextlib
import datetime
import errno
import fcntl
import hashlib
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

STATE = ".codex-pi"
NOTES_MAX_BYTES = 24000  # Pi checkpoint limit (bytes of UTF-8 JSON), not 24 KiB
MAX_PAGE = 1000          # bound for sessions list/read/search limits
MAX_TEXT_CHARS = 1_000_000
MAX_TIMEOUT_S = 86400.0  # verify timeout must be finite, > 0 and <= 24h
MAX_LOCK_TIMEOUT_S = 3600.0
MAX_HASH_BYTES = 50 << 20
NOTE_FIELDS = {"goal": str, "constraints": list, "decisions": list,
               "progress": str, "next": str, "references": list}
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
HANDOFF_ID = re.compile(r"^H\d{4,}$")
OUTCOMES = ("running", "failed", "succeeded", "inconclusive")
TAIL_BYTES = 4000
VERIFY_NOTE = ("Receipt records exit status and workspace state only; "
               "a zero exit does not establish that requirements are met.")
HANDOFF_CAVEAT = ("Freshness guard compares notes revisions only: work done in the source "
                  "session after prepare without saving new notes cannot be detected. "
                  "Recheck current files before acting.")


class CodexPiError(Exception):
    def __init__(self, message, code=3):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------- utilities

def now_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="microseconds")


def stamp(iso):
    return re.sub(r"[^0-9T]", "", iso.split("+")[0])[:22] + "Z"


def sha256_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def safe_id(value, what="session id"):
    if not isinstance(value, str) or not SAFE_ID.fullmatch(value) or ".." in value:
        raise CodexPiError(f"unsafe {what}: {value!r} (allowed: [A-Za-z0-9._-], max 128, no '..')")
    return value


def dumps(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def state_dir(root, *parts, create=True):
    """Return a path inside ROOT/.codex-pi, refusing symlinked state directories."""
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        raise CodexPiError(f"workspace root is not a directory: {root}")
    path = root
    for part in (STATE,) + parts:
        path = os.path.join(path, part)
        if os.path.islink(path):
            raise CodexPiError(f"refusing symlinked state path: {path}")
        if create and not os.path.isdir(path):
            with contextlib.suppress(FileExistsError):
                os.mkdir(path, 0o700)
            if os.path.islink(path) or not os.path.isdir(path):
                raise CodexPiError(f"state path is not a real directory: {path}")
            if part == STATE:
                with contextlib.suppress(FileExistsError):
                    write_immutable(os.path.join(path, ".gitignore"),
                                    "# codex-pi local state; never publish\n*\n", 0o600)
    return path


_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0)


def _open_state(path, flags, mode=0o600):
    """os.open that refuses a symlinked final path component."""
    try:
        return os.open(path, flags | _NOFOLLOW, mode)
    except OSError as e:
        if e.errno in (errno.ELOOP, errno.EMLINK) or os.path.islink(path):
            raise CodexPiError(f"refusing symlinked state file: {path}")
        raise


def _fsync_dir(d):
    with contextlib.suppress(OSError):
        fd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def write_immutable(path, data, mode=0o400):
    """Create-only write (O_EXCL|O_NOFOLLOW); final permissions 0400 by default."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    fd = _open_state(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
            os.fchmod(f.fileno(), mode)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(path)
        raise
    _fsync_dir(os.path.dirname(path))


def write_atomic(path, data):
    """mkstemp (0600, O_EXCL) + fsync + os.replace; a symlink at PATH is replaced, not followed."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    d, base = os.path.split(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{base}.", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
    _fsync_dir(d)


def read_bytes(path):
    """Read a state file, refusing symlinked leaves and non-regular files."""
    with os.fdopen(_open_state(path, os.O_RDONLY), "rb") as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise CodexPiError(f"state file is not a regular file: {path}")
        return f.read()


def read_json(path):
    try:
        return json.loads(read_bytes(path).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise CodexPiError(f"corrupt state file {path}: {e}")


def _finite(value, what, lo, hi, allow_zero=False):
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise CodexPiError(f"{what} must be a number")
    if not math.isfinite(v) or v > hi or (v < lo if allow_zero else v <= lo):
        raise CodexPiError(f"{what} must be finite and in {'[' if allow_zero else '('}{lo}, {hi}]")
    return v


def _bounded_int(value, what, lo, hi=None):
    if isinstance(value, bool) or not isinstance(value, int) or value < lo or \
            (hi is not None and value > hi):
        raise CodexPiError(f"{what} must be an integer >= {lo}" + (f" and <= {hi}" if hi else ""))
    return value


@contextlib.contextmanager
def locked(root, name, timeout=None):
    """Exclusive advisory lock (fcntl.flock) with bounded wait."""
    if timeout is None:
        timeout = os.environ.get("CODEX_PI_LOCK_TIMEOUT", "10")
    timeout = _finite(timeout, "lock timeout", 0, MAX_LOCK_TIMEOUT_S, allow_zero=True)
    path = os.path.join(state_dir(root, "locks"), name + ".lock")
    fd = _open_state(path, os.O_RDWR | os.O_CREAT, 0o600)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise CodexPiError(f"lock timeout after {timeout}s: {name}", 4)
                time.sleep(0.02)
        yield
    finally:
        os.close(fd)  # closing releases the flock


# ---------------------------------------------------------------- notes

def validate_notes(raw):
    if isinstance(raw, str):
        raw = raw.encode("utf-8")
    if len(raw) > NOTES_MAX_BYTES:
        raise CodexPiError(f"notes exceed {NOTES_MAX_BYTES} UTF-8 bytes ({len(raw)})")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise CodexPiError(f"notes are not valid UTF-8 JSON: {e}")
    if not isinstance(data, dict):
        raise CodexPiError("notes must be a JSON object")
    missing = [k for k in NOTE_FIELDS if k not in data]
    extra = sorted(set(data) - set(NOTE_FIELDS))
    if missing or extra:
        raise CodexPiError(f"notes fields invalid; missing={missing} unexpected={extra}")
    for key, typ in NOTE_FIELDS.items():
        val = data[key]
        if not isinstance(val, typ):
            raise CodexPiError(f"notes field {key!r} must be {typ.__name__}")
        if typ is list and not all(isinstance(x, str) for x in val):
            raise CodexPiError(f"notes field {key!r} must be an array of strings")
    return data


def render_notes(session, revision, saved_at, data):
    out = [f"# Session notes: {session} (revision {revision})", f"Saved: {saved_at}", ""]
    for key in NOTE_FIELDS:
        out.append(f"## {key.capitalize()}")
        val = data[key]
        if isinstance(val, list):
            out.extend(f"- {x}" for x in val) if val else out.append("- (none)")
        else:
            out.append(val if val else "(empty)")
        out.append("")
    return "\n".join(out)


def save_notes(root, session, raw):
    """Validate and store an immutable notes revision; update latest.{json,md}."""
    safe_id(session)
    data = validate_notes(raw)
    with locked(root, "notes-" + session):
        d = state_dir(root, "notes", session)
        hist = state_dir(root, "notes", session, "history")
        revision = (latest_revision(root, session) or 0) + 1
        saved_at = now_iso()
        base = f"r{revision:06d}-{stamp(saved_at)}"
        record = {"session": session, "revision": revision, "saved_at": saved_at, "notes": data}
        body = dumps(record)
        md = render_notes(session, revision, saved_at, data)
        write_immutable(os.path.join(hist, base + ".json"), body)
        write_immutable(os.path.join(hist, base + ".md"), md)
        latest = dict(record, file=os.path.join("history", base + ".json"),
                      sha256=sha256_bytes(body.encode("utf-8")))
        write_atomic(os.path.join(d, "latest.json"), dumps(latest))
        write_atomic(os.path.join(d, "latest.md"), md)
    return latest


_REV_FILE = re.compile(r"^r(\d{6})-[0-9TZ]+\.json$")


def _history(root, session):
    hist = state_dir(root, "notes", safe_id(session), "history", create=False)
    if not os.path.isdir(hist):
        return hist, {}
    return hist, {int(m.group(1)): n for n in os.listdir(hist) if (m := _REV_FILE.match(n))}


def latest_revision(root, session):
    """Highest immutable history revision (source of truth; latest.json is a copy)."""
    return max(_history(root, session)[1], default=None)


def _revision_file(root, session, revision):
    hist, revs = _history(root, session)
    if revision in revs:
        return os.path.join(hist, revs[revision])
    raise CodexPiError(f"notes revision {revision} not found for session {session}")


def read_notes(root, session, revision=None):
    safe_id(session)
    if revision is None:
        revision = latest_revision(root, session)
        if revision is None:
            raise CodexPiError(f"no notes for session {session}")
    _bounded_int(revision, "revision", 1)
    path = _revision_file(root, session, revision)
    body = read_bytes(path)
    try:
        rec = json.loads(body)
    except json.JSONDecodeError as e:
        raise CodexPiError(f"corrupt notes revision {path}: {e}")
    rec["sha256"] = sha256_bytes(body)
    rec["file"] = path
    rec["markdown"] = render_notes(session, rec["revision"], rec["saved_at"], rec["notes"])
    return rec


# ---------------------------------------------------------------- transcripts / handoffs

def register_transcript(root, session, path, directory=None):
    """Register the local Codex transcript file for a session (used by handoff prepare).

    Same archive-root rule as `sessions read` (.jsonl, must resolve inside --dir or the Codex
    sessions dir or its own directory), and the selected path itself may not be a symlink.
    """
    safe_id(session)
    if os.path.islink(path):
        raise CodexPiError(f"refusing symlinked transcript path: {path}")
    _check_session_file(path, directory)
    real = os.path.realpath(path)
    rec = {"session": session, "path": real, "registered_at": now_iso()}
    with locked(root, "transcripts"):
        write_atomic(os.path.join(state_dir(root, "transcripts"), session + ".json"), dumps(rec))
    return rec


def _transcript_ref(root, session):
    path = os.path.join(state_dir(root, "transcripts"), session + ".json")
    if not os.path.isfile(path):
        return None
    ref = read_json(path)
    h, size, lines = hashlib.sha256(), 0, 0
    try:
        with os.fdopen(_open_state(ref["path"], os.O_RDONLY), "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
                size += len(chunk)
                lines += chunk.count(b"\n")
    except (OSError, CodexPiError) as e:
        ref.update(available=False, reason=str(e))
        return ref
    ref.update(available=True, size=size, sha256=h.hexdigest(), line_count=lines)
    return ref


def _handoff_dir(root):
    return state_dir(root, "handoffs")


def _all_handoffs(root):
    d = _handoff_dir(root)
    return [read_json(os.path.join(d, n)) for n in sorted(os.listdir(d))
            if n.endswith(".json") and HANDOFF_ID.fullmatch(n[:-5])]


def prepare_handoff(root, session):
    """Pin the latest notes revision (+ registered transcript ref) into a pending handoff.

    Lock order everywhere is handoffs -> notes-<session> (save_notes takes only the latter).
    """
    safe_id(session)
    with locked(root, "handoffs"), locked(root, "notes-" + session):
        notes = read_notes(root, session)
        existing = _all_handoffs(root)
        n = max((int(h["id"][1:]) for h in existing), default=0) + 1
        hid = f"H{n:04d}"
        ts = now_iso()
        for h in existing:
            if h["status"] == "pending" and h["source_session"] == session:
                h.update(status="superseded", superseded_by=hid, superseded_at=ts)
                write_atomic(os.path.join(_handoff_dir(root), h["id"] + ".json"), dumps(h))
        rec = {"id": hid, "status": "pending", "created_at": ts, "source_session": session,
               "notes_revision": notes["revision"], "notes_sha256": notes["sha256"],
               "transcript": _transcript_ref(root, session),
               "read_at": None, "consumed_at": None, "consumed_by": None}
        write_atomic(os.path.join(_handoff_dir(root), hid + ".json"), dumps(rec))
    return dict(rec, warning=HANDOFF_CAVEAT)


def list_handoffs(root):
    return _all_handoffs(root)


def _select_handoff(root, hid):
    hs = _all_handoffs(root)
    if hid is not None:
        if not isinstance(hid, str) or not HANDOFF_ID.fullmatch(hid):
            raise CodexPiError(f"invalid handoff id: {hid!r}")
        for h in hs:
            if h["id"] == hid:
                return h
        raise CodexPiError(f"handoff not found: {hid}")
    pending = [h for h in hs if h["status"] == "pending"]
    if len(pending) != 1:
        ids = ", ".join(h["id"] for h in pending) or "none"
        raise CodexPiError(f"cannot auto-select handoff: {len(pending)} pending ({ids}); pass --id")
    return pending[0]


def _pinned_notes(root, h):
    """Pinned notes with digest re-verified; pending handoffs must also still be current."""
    sess, pinned = h["source_session"], h["notes_revision"]
    if h["status"] == "pending":
        latest = latest_revision(root, sess)
        if latest != pinned:
            raise CodexPiError(
                f"handoff {h['id']} is stale: notes for {sess} are now revision {latest}, "
                f"pinned revision {pinned}; run `handoff prepare --session {sess}` again "
                f"(the pinned revision stays readable via `notes read --session {sess} "
                f"--revision {pinned}`)")
    notes = read_notes(root, sess, pinned)
    if notes["sha256"] != h["notes_sha256"]:
        raise CodexPiError(f"pinned notes revision changed on disk for {h['id']}")
    return notes


def read_handoff(root, hid=None):
    """Return handoff + pinned notes (integrity-checked); marks read_at on first read.

    A pending handoff whose source session saved newer notes after prepare is rejected
    (re-prepare). See HANDOFF_CAVEAT for what this guard cannot detect.
    """
    with locked(root, "handoffs"):
        h = _select_handoff(root, hid)
        with locked(root, "notes-" + safe_id(h["source_session"])):
            notes = _pinned_notes(root, h)
            if h["status"] == "pending" and not h["read_at"]:
                h["read_at"] = now_iso()
                write_atomic(os.path.join(_handoff_dir(root), h["id"] + ".json"), dumps(h))
    return dict(h, notes=notes["notes"], notes_markdown=notes["markdown"],
                warning=HANDOFF_CAVEAT)


def render_handoff(h, root):
    t = h.get("transcript")
    if t and t.get("available"):
        tline = f"{t['path']} (sha256 {t['sha256']}, {t['line_count']} lines at prepare)"
    elif t:
        tline = f"{t['path']} (missing at prepare)"
    else:
        tline = "none registered"
    return "\n".join([
        f"# Handoff {h['id']} ({h['status']})",
        f"Source session: {h['source_session']}",
        f"Notes revision: {h['notes_revision']} (sha256 {h['notes_sha256']})",
        f"Transcript: {tline}", f"Warning: {HANDOFF_CAVEAT}", "", h["notes_markdown"],
        f"After reading, consume with: python3 codex_pi.py --root {root} "
        f"handoff consume --id {h['id']} --session <NEW_SESSION_ID>", ""])


def consume_handoff(root, hid, new_session):
    """Mark a read, still-current pending handoff consumed (digest re-verified now)."""
    safe_id(new_session)
    with locked(root, "handoffs"):
        h = _select_handoff(root, hid)
        if h["status"] != "pending":
            raise CodexPiError(f"handoff {h['id']} is {h['status']}, not pending")
        if not h["read_at"]:
            raise CodexPiError(f"handoff {h['id']} has not been read yet; run handoff read first")
        if new_session == h["source_session"]:
            raise CodexPiError(f"handoff {h['id']} cannot be consumed by its source session "
                               f"{new_session}; pass the new session id")
        with locked(root, "notes-" + safe_id(h["source_session"])):
            _pinned_notes(root, h)
            h.update(status="consumed", consumed_at=now_iso(), consumed_by=new_session)
            write_atomic(os.path.join(_handoff_dir(root), h["id"] + ".json"), dumps(h))
    return dict(h, warning=HANDOFF_CAVEAT)


# ---------------------------------------------------------------- tickets

def _one_line(value, what):
    if not value or "\n" in value or "\r" in value:
        raise CodexPiError(f"{what} must be a non-empty single line")
    return value


def _ticket_path(root, tid):
    _bounded_int(tid, "ticket id", 1)
    path = os.path.join(state_dir(root, "tickets"), f"{tid:03d}.md")
    if not os.path.lexists(path):
        raise CodexPiError(f"ticket {tid} not found")
    return path


def _ticket_header(text):
    head = {}
    for line in text.split("\n\n", 1)[0].splitlines()[1:]:
        k, _, v = line.partition(": ")
        head[k] = v
    return head


def _ticket_update(text, status=None, trials=None):
    first, sep, rest = text.partition("\n\n")
    lines = first.splitlines()
    for i, line in enumerate(lines):
        if status and line.startswith("Status: "):
            lines[i] = f"Status: {status}"
        if trials is not None and line.startswith("Trials: "):
            lines[i] = f"Trials: {trials}"
    return "\n".join(lines) + sep + rest


def ticket_open(root, title, problem):
    _one_line(title, "title")
    if not problem:
        raise CodexPiError("problem must be non-empty")
    with locked(root, "tickets"):
        d = state_dir(root, "tickets")
        ids = [int(n[:-3]) for n in os.listdir(d) if re.match(r"^\d{3,}\.md$", n)]
        tid = max(ids, default=0) + 1
        ts = now_iso()
        body = (f"# Ticket {tid:03d}: {title}\nStatus: open\nOpened: {ts}\nTrials: 0\n\n"
                f"## Problem\n{problem}\n\n## History\n\n### {ts} opened\n")
        write_immutable(os.path.join(d, f"{tid:03d}.md"), body)
    return {"id": tid, "path": os.path.join(d, f"{tid:03d}.md"), "status": "open"}


def _ticket_append(root, tid, build):
    with locked(root, "tickets"):
        path = _ticket_path(root, tid)
        text = read_bytes(path).decode("utf-8")
        head = _ticket_header(text)
        if head.get("Status") != "open":
            raise CodexPiError(f"ticket {tid} is {head.get('Status')}; no further updates")
        text, info = build(text, head, now_iso())
        write_atomic(path, text)
    return dict(info, id=tid, path=path)


def ticket_trial(root, tid, approach, result, outcome):
    if outcome not in OUTCOMES:
        raise CodexPiError(f"outcome must be one of {OUTCOMES}")

    def build(text, head, ts):
        n = int(head.get("Trials", "0")) + 1
        text = _ticket_update(text, trials=n).rstrip("\n") + (
            f"\n\n### {ts} trial {n}: {outcome}\n"
            f"Approach:\n{approach}\n\nResult:\n{result}\n")
        return text, {"trial": n, "outcome": outcome, "status": "open"}
    return _ticket_append(root, tid, build)


def ticket_resolve(root, tid, decision, evidence):
    if not decision or not evidence:
        raise CodexPiError("decision and evidence must be non-empty")

    def build(text, head, ts):
        text = _ticket_update(text, status="resolved").rstrip("\n") + (
            f"\n\n### {ts} resolved\nDecision:\n{decision}\n\n"
            f"Evidence (as stated by the resolver; not independently verified by codex-pi):\n"
            f"{evidence}\n")
        return text, {"status": "resolved"}
    return _ticket_append(root, tid, build)


def ticket_read(root, tid):
    return read_bytes(_ticket_path(root, tid)).decode("utf-8")


# ---------------------------------------------------------------- Codex sessions

def default_sessions_dir():
    home = os.environ.get("CODEX_HOME") or os.path.join(os.path.expanduser("~"), ".codex")
    d = os.path.join(home, "sessions")
    return d if os.path.isdir(d) else None


def _within(path, root):
    root = os.path.realpath(root)
    real = os.path.realpath(path)
    return real == root or real.startswith(root.rstrip(os.sep) + os.sep)


def _session_files(directory):
    if not directory or not os.path.isdir(directory):
        raise CodexPiError(f"sessions directory not found: {directory!r} (pass --dir)")
    out = []
    for dp, dns, fns in os.walk(directory, followlinks=False):
        dns[:] = sorted(n for n in dns if not os.path.islink(os.path.join(dp, n)))
        for n in fns:
            p = os.path.join(dp, n)
            if n.endswith(".jsonl") and not os.path.islink(p) and os.path.isfile(p):
                out.append(p)
    return sorted(out, key=lambda p: (os.path.getmtime(p), p), reverse=True)


def _session_meta(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for _ in range(5):
            line = f.readline()
            if not line:
                break
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(o, dict) and o.get("type") == "session_meta":
                p = o.get("payload") or {}
                return {k: p.get(k) for k in ("id", "timestamp", "cwd", "cli_version")}
    return {}


def list_sessions(directory=None, limit=50):
    _bounded_int(limit, "limit", 1, MAX_PAGE)
    directory = directory or default_sessions_dir()
    files = _session_files(directory)
    items = []
    for p in files[:limit]:
        st = os.stat(p)
        items.append({"path": p, "size": st.st_size, "mtime": st.st_mtime,
                      "meta": _session_meta(p)})
    return {"dir": os.path.realpath(directory), "total": len(files), "sessions": items}


TEXT_PART_TYPES = {"text", "input_text", "output_text"}
REASONING_CHANNELS = {"analysis", "reasoning", "thinking"}


def _texts(content):
    """Join visible text parts verbatim; list every other part only by type.

    Allow-list: reasoning_text/summary_text/thinking/images/etc. are never joined, even
    when they carry a `text` field.
    """
    if isinstance(content, str):
        return content, []
    if not isinstance(content, list):
        return "", [] if content is None else [type(content).__name__]
    texts, omitted = [], []
    for part in content:
        if isinstance(part, str):
            texts.append(part)
        elif isinstance(part, dict) and isinstance(part.get("text"), str) and \
                str(part.get("type", "text")).lower() in TEXT_PART_TYPES:
            texts.append(part["text"])
        else:
            omitted.append(str(part.get("type", "unknown")) if isinstance(part, dict) else "unknown")
    return "\n".join(texts), omitted


def _reasoning_channel(d):
    return any(str(d.get(k) or "").lower() in REASONING_CHANNELS for k in ("channel", "phase"))


_CONTEXT_PREFIXES = ("<environment_context>", "<user_instructions>", "# AGENTS.md instructions",
                     "<permissions instructions>")


def _response_entry(p):
    t = p.get("type")
    if t == "message":
        role = p.get("role")
        if role not in ("user", "assistant"):
            return None, f"message:{role}"
        if _reasoning_channel(p):
            return None, "message:reasoning-channel"
        text, omitted = _texts(p.get("content"))
        kinds = (p.get("internal_chat_message_metadata_passthrough") or {}).get("content_item_kinds")
        if role == "user":
            injected = (not any(str(k).startswith("user.") for k in kinds)) if kinds \
                else text.lstrip().startswith(_CONTEXT_PREFIXES)
            if injected:
                return None, "message:user-injected-context"
        e = {"role": role, "text": text}
        if p.get("phase"):
            e["phase"] = p["phase"]
        if omitted:
            e["omitted_parts"] = omitted
        return e, None
    if t in ("function_call", "custom_tool_call"):
        body = p.get("arguments") if t == "function_call" else p.get("input")
        return {"role": "tool_call", "name": p.get("name"), "call_id": p.get("call_id"),
                "text": body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)}, None
    if t in ("local_shell_call", "web_search_call"):
        return {"role": "tool_call", "name": t, "call_id": p.get("call_id"),
                "text": json.dumps(p.get("action"), ensure_ascii=False)}, None
    if t in ("function_call_output", "custom_tool_call_output", "local_shell_call_output"):
        text, omitted = _texts(p.get("output"))
        e = {"role": "tool_result", "call_id": p.get("call_id"), "text": text}
        if omitted:
            e["omitted_parts"] = omitted
        return e, None
    return None, f"response_item:{t}"


def _event_entry(p):
    t = p.get("type")
    if t in ("user_message", "agent_message") and isinstance(p.get("message"), str):
        if _reasoning_channel(p):
            return None, "event_msg:reasoning-channel"
        return {"role": "user" if t == "user_message" else "assistant", "text": p["message"]}, None
    if t == "item_completed" and isinstance(p.get("item"), dict):
        it = p["item"]
        if it.get("type") in ("UserMessage", "AgentMessage"):
            if _reasoning_channel(it):
                return None, "event_item:reasoning-channel"
            text, omitted = _texts(it.get("content"))
            e = {"role": "user" if it["type"] == "UserMessage" else "assistant", "text": text,
                 "id": it.get("id")}
            if omitted:
                e["omitted_parts"] = omitted
            return e, None
        return None, f"event_item:{it.get('type')}"
    return None, f"event_msg:{t}"


OPAQUE_TOP = {"session_meta", "turn_context", "world_state", "token_usage_record", "compacted"}
OMITTED_BY_DESIGN = (
    "session_meta except id/timestamp/cwd/cli_version (account ids, git info, base instructions)",
    "turn_context (model, effort, approval/sandbox policy), world_state, token usage",
    "developer/system messages and injected user context (project instruction files, "
    "environment_context, user_instructions, permissions)",
    "reasoning: reasoning records, encrypted content, reasoning summaries, reasoning/summary "
    "content parts, and analysis/reasoning channel or phase messages",
    "compacted history summaries (no summaries are produced or returned)",
    "non-text content parts (images, files, refusals, unknown) - listed by type only",
)


def parse_session(path):
    """Parse a Codex JSONL transcript into visible entries (original text, no summaries).

    response_item records are canonical. event_msg messages (user_message/agent_message and
    item_completed UserMessage/AgentMessage) are merged in file order; one is dropped only as
    an identifiable paired echo: the immediately preceding visible entry has the same role and
    text but comes from a different source kind not yet in that pair. Genuine repeats (same
    kind, or separated by any other visible entry) and unmatched event messages are kept.
    Everything in OMITTED_BY_DESIGN is deliberately left out and counted under `ignored`.
    """
    stream = []
    ignored, unsupported, seen = {}, [], set()
    meta = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for lineno, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                unsupported.append({"line": lineno, "reason": "invalid JSON"})
                continue
            if not isinstance(o, dict):
                unsupported.append({"line": lineno, "reason": "not an object"})
                continue
            top = o.get("type")
            p = o.get("payload")
            if top == "session_meta" and isinstance(p, dict):
                meta = {k: p.get(k) for k in ("id", "timestamp", "cwd", "cli_version")}
            if top in OPAQUE_TOP:
                ignored[top] = ignored.get(top, 0) + 1
                continue
            if top == "response_item" and isinstance(p, dict):
                e, why = _response_entry(p)
                kind = "response_item"
            elif top == "event_msg" and isinstance(p, dict):
                e, why = _event_entry(p)
                kind = "event_item" if p.get("type") == "item_completed" else "event_msg"
            elif "payload" not in o and top in ("message", "function_call", "function_call_output",
                                                "custom_tool_call", "custom_tool_call_output",
                                                "reasoning", "local_shell_call"):
                e, why = _response_entry(o)  # legacy un-wrapped rollout line
                kind, p = "response_item", o
            elif o.get("record_type") == "state" or (top is None and "instructions" in o):
                ignored["legacy_header"] = ignored.get("legacy_header", 0) + 1
                continue
            else:
                unsupported.append({"line": lineno, "reason": f"unknown record type {top!r}"})
                continue
            if e is None:
                ignored[why] = ignored.get(why, 0) + 1
                continue
            pid = p.get("id") or e.get("id")
            key = (top, pid, e["role"], e["text"]) if pid else None
            if key and key in seen:
                ignored["duplicate"] = ignored.get("duplicate", 0) + 1
                continue
            if key:
                seen.add(key)
            e = dict(e, line=lineno, id=pid, timestamp=o.get("timestamp"),
                     source="response_item" if kind == "response_item" else "event_msg")
            stream.append((kind, e))
    entries, pair = [], None  # pair: [entry index, role, text, source kinds already paired]
    for kind, e in stream:
        if e["role"] not in ("user", "assistant"):
            entries.append(e)
            pair = None
        elif pair and pair[1:3] == [e["role"], e["text"]] and kind not in pair[3]:
            pair[3].add(kind)
            ignored["event_msg_echo"] = ignored.get("event_msg_echo", 0) + 1
            if kind == "response_item":  # canonical record replaces its echo in place
                entries[pair[0]] = e
        else:
            entries.append(e)
            pair = [len(entries) - 1, e["role"], e["text"], {kind}]
    if any(k == "response_item" for k, _ in stream):
        fmt = "response_item"
    elif stream:
        fmt = "event_msg"
    else:
        fmt = "unsupported" if unsupported or not ignored else "no_visible_entries"
    for i, e in enumerate(entries):
        e["entry"] = i
    return {"file": os.path.realpath(path), "format": fmt, "meta": meta, "entries": entries,
            "ignored": ignored, "omitted_by_design": list(OMITTED_BY_DESIGN),
            "unsupported": unsupported[:50], "unsupported_count": len(unsupported)}


def _check_session_file(path, directory=None):
    if not str(path).endswith(".jsonl"):
        raise CodexPiError(f"session file must be a .jsonl transcript: {path}")
    if not os.path.isfile(path):
        raise CodexPiError(f"session file not found: {path}")
    root = directory or default_sessions_dir()
    if not root or not _within(path, root) and not directory:
        root = os.path.dirname(os.path.abspath(path))
    if not _within(path, root):
        raise CodexPiError(f"session file resolves outside the selected archive root: {path}")
    return path


def read_session(path, offset=0, limit=50, max_chars=20000, directory=None):
    _bounded_int(offset, "offset", 0)
    _bounded_int(limit, "limit", 1, MAX_PAGE)
    _bounded_int(max_chars, "max-chars", 0, MAX_TEXT_CHARS)  # 0 = full text (documented)
    _check_session_file(path, directory)
    doc = parse_session(path)
    total = len(doc["entries"])
    page = []
    for e in doc["entries"][offset:offset + limit]:
        e = dict(e)
        if max_chars and len(e["text"]) > max_chars:
            e.update(text=e["text"][:max_chars], truncated=True, text_chars=len(e["text"]))
        page.append(e)
    doc.update(entries=page, offset=offset, limit=limit, total_entries=total,
               next_offset=offset + limit if offset + limit < total else None)
    return doc


def search_sessions(query, directory=None, limit=20, context=120):
    if not query:
        raise CodexPiError("query must be non-empty")
    _bounded_int(limit, "limit", 1, MAX_PAGE)
    directory = directory or default_sessions_dir()
    q = query.casefold()
    matches, scanned = [], 0
    for p in _session_files(directory):
        scanned += 1
        for e in parse_session(p)["entries"]:
            idx = e["text"].casefold().find(q)
            if idx < 0:
                continue
            s = max(0, idx - context)
            matches.append({"file": p, "line": e["line"], "entry": e["entry"], "role": e["role"],
                            "id": e["id"], "match_offset": idx,
                            "snippet": e["text"][s:idx + len(query) + context],
                            "snippet_start": s})
            if len(matches) >= limit:
                return {"query": query, "matches": matches, "files_scanned": scanned,
                        "truncated": True}
    return {"query": query, "matches": matches, "files_scanned": scanned, "truncated": False}


# ---------------------------------------------------------------- verify

def _git(root, *args):
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    return subprocess.run(["git", "-C", root, *args], capture_output=True, env=env,
                          timeout=60, stdin=subprocess.DEVNULL)


def _hash_or_size(path, max_bytes=None):
    max_bytes = MAX_HASH_BYTES if max_bytes is None else max_bytes
    try:
        st = os.lstat(path)
        if os.path.islink(path):
            return "symlink:" + os.readlink(path)
        if st.st_size > max_bytes:
            return f"size:{st.st_size}:mtime:{st.st_mtime_ns}"
        return sha256_file(path)
    except OSError as e:
        return f"error:{e.__class__.__name__}"


SNAPSHOT_MAX_FILES = 5000
SNAPSHOT_EXCLUDED = {
    "git": ["files ignored by git (.gitignore, info/exclude, core.excludesFile): not listed or hashed",
            ".codex-pi state",
            "tracked edits: one digest of `git diff HEAD` (no per-file hashes)",
            "nested repositories/submodules: gitlink only, not their working trees"],
    "fs": [".git and .codex-pi directories", "symlinks: link target string only, not followed"],
}


def snapshot(root, max_files=None):
    """Approximate change-detection snapshot of the workspace, excluding .codex-pi state.

    Not a complete revision record: see SNAPSHOT_EXCLUDED, MAX_HASH_BYTES and max_files.
    """
    max_files = SNAPSHOT_MAX_FILES if max_files is None else max_files
    root = os.path.abspath(root)
    spec = ["--", ".", f":(exclude){STATE}"]
    errors = []

    def git(*a):
        try:
            r = _git(root, *a)
        except (OSError, subprocess.TimeoutExpired) as e:
            errors.append(f"git {a[0]}: {e.__class__.__name__}")
            return b""
        if r.returncode != 0:
            errors.append(f"git {a[0]} exited {r.returncode}")
        return r.stdout

    try:
        inside = _git(root, "rev-parse", "--is-inside-work-tree")
    except (OSError, subprocess.TimeoutExpired):
        inside = None
    if inside is not None and inside.returncode == 0 and inside.stdout.strip() == b"true":
        h = _git(root, "rev-parse", "--verify", "-q", "HEAD")
        head = h.stdout.decode().strip() if h.returncode == 0 else None
        diff_args = ["diff", "--binary", "--no-ext-diff", "--no-color"]
        diff = git(*diff_args, "HEAD", *spec) if head else \
            git(*diff_args, "--cached", *spec) + git(*diff_args, *spec)
        names = [n.decode("utf-8", "surrogateescape") for n in
                 git("ls-files", "--others", "--exclude-standard", "-z", *spec).split(b"\0") if n]
        untracked = {n: _hash_or_size(os.path.join(root, n)) for n in sorted(names)[:max_files]}
        return {"kind": "git", "head": head, "dirty": bool(diff or names),
                "dirty_diff_sha256": sha256_bytes(diff), "untracked": untracked,
                "untracked_truncated": len(names) > max_files, "errors": errors,
                "_metadata_only": [n for n, v in untracked.items() if v.startswith("size:")]}
    files, truncated = {}, False
    for dp, dns, fns in os.walk(root, followlinks=False):
        dns[:] = sorted(n for n in dns if n not in (STATE, ".git"))
        for n in sorted(fns):
            if len(files) >= max_files:
                truncated = True
                break
            p = os.path.join(dp, n)
            files[os.path.relpath(p, root)] = _hash_or_size(p)
        if truncated:
            break
    return {"kind": "fs", "manifest_sha256": sha256_bytes(dumps(files).encode()),
            "files": len(files), "truncated": truncated, "errors": errors, "_files": files,
            "_metadata_only": [n for n, v in files.items() if v.startswith("size:")]}


def _diff_snapshots(pre, post):
    if pre["kind"] != post["kind"]:
        return True, ["snapshot kind changed"], 1
    if pre["kind"] == "git":
        changed = [k for k in ("head", "dirty_diff_sha256") if pre[k] != post[k]]
        paths = sorted(set(pre["untracked"]) | set(post["untracked"]))
        changed += [f"untracked:{p}" for p in paths if pre["untracked"].get(p) != post["untracked"].get(p)]
    else:
        a, b = pre["_files"], post["_files"]
        changed = [f"file:{p}" for p in sorted(set(a) | set(b)) if a.get(p) != b.get(p)]
    return bool(changed), changed[:200], len(changed)


def _snapshot_limitations(pre, post, total_changes):
    """Explicit receipt statement of what the pre/post snapshots do NOT cover."""
    meta = sorted(set(pre["_metadata_only"]) | set(post["_metadata_only"]))
    excluded = []
    for kind in dict.fromkeys((pre["kind"], post["kind"])):
        excluded += SNAPSHOT_EXCLUDED[kind]
    return {
        "complete_revision_record": False,
        "excluded": excluded,
        "metadata_only_rule": (f"files over {MAX_HASH_BYTES} bytes are recorded by size+mtime only; "
                               "same-size same-mtime edits are not detected"),
        "metadata_only_paths": meta[:200], "metadata_only_count": len(meta),
        "snapshot_file_cap": SNAPSHOT_MAX_FILES,
        "snapshot_truncated": any(s.get("truncated") or s.get("untracked_truncated")
                                  for s in (pre, post)),
        "changes_listed": min(total_changes, 200), "changes_total": total_changes,
        "changes_truncated": total_changes > 200,
        "errors": pre["errors"] + post["errors"],
        "note": ("A passed status means only that this argv exited 0 while this approximate "
                 "snapshot was taken; it does not establish which complete revision was tested."),
    }


def _group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _kill_group(pgid, grace=1.0):
    if not _group_alive(pgid):
        return False
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGTERM)
    end = time.monotonic() + grace
    while time.monotonic() < end and _group_alive(pgid):
        time.sleep(0.02)
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(pgid, signal.SIGKILL)
    return True


def _tail(path):
    with os.fdopen(_open_state(path, os.O_RDONLY), "rb") as f:
        size = os.fstat(f.fileno()).st_size
        f.seek(max(0, size - TAIL_BYTES))
        data = f.read()
    return data.decode("utf-8", "replace"), size > TAIL_BYTES, size


def run_verify(root, argv, timeout, cwd=None):
    """Run argv once (no shell) in its own process group and write an immutable receipt."""
    if not argv:
        raise CodexPiError("verify needs a command after --")
    timeout = _finite(timeout, "timeout", 0, MAX_TIMEOUT_S)
    root = os.path.abspath(root)
    cwd = os.path.abspath(cwd or root)
    with locked(root, "verify"):
        d = state_dir(root, "verify")
        ids = [int(n[1:]) for n in os.listdir(d) if re.match(r"^V\d{4,}$", n)]
        vid = f"V{max(ids, default=0) + 1:04d}"
        vdir = os.path.join(d, vid)
        os.mkdir(vdir, 0o700)
    out_p, err_p = os.path.join(vdir, "stdout.log"), os.path.join(vdir, "stderr.log")
    pre = snapshot(root)
    started, t0 = now_iso(), time.monotonic()
    exit_code, sig, status, error, leftover = None, None, None, None, False
    new = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    with os.fdopen(_open_state(out_p, new), "wb") as fo, \
            os.fdopen(_open_state(err_p, new), "wb") as fe:
        try:
            proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=fo,
                                    stderr=fe, start_new_session=True)
        except OSError as e:
            status, error = "error", f"{e.__class__.__name__}: {e}"
        else:
            try:
                rc = proc.wait(timeout=timeout)
                status = "passed" if rc == 0 else "failed"
            except subprocess.TimeoutExpired:
                _kill_group(proc.pid)
                rc = proc.wait()
                status = "timeout"
            leftover = _kill_group(proc.pid)  # background descendants left in the group
            exit_code = rc
            if rc < 0:
                sig = signal.Signals(-rc).name
    duration = round(time.monotonic() - t0, 3)
    post = snapshot(root)
    changed, changes, total_changes = _diff_snapshots(pre, post)
    so, so_trunc, so_size = _tail(out_p)
    se, se_trunc, se_size = _tail(err_p)
    strip = lambda s: {k: v for k, v in s.items() if not k.startswith("_")}
    receipt = {
        "id": vid, "argv": list(argv), "cwd": cwd, "root": root, "started_at": started,
        "ended_at": now_iso(), "duration_s": duration, "timeout_s": timeout,
        "status": status, "success": status == "passed", "exit_code": exit_code,
        "signal": sig, "error": error, "descendants_killed_after_exit": leftover,
        "stdout_tail": so, "stdout_truncated": so_trunc, "stdout_bytes": so_size,
        "stderr_tail": se, "stderr_truncated": se_trunc, "stderr_bytes": se_size,
        "stdout_log": out_p, "stderr_log": err_p,
        "stdout_sha256": sha256_file(out_p), "stderr_sha256": sha256_file(err_p),
        "pre": strip(pre), "post": strip(post), "state_changed": changed, "changes": changes,
        "snapshot_limitations": _snapshot_limitations(pre, post, total_changes),
        "note": VERIFY_NOTE,
    }
    write_immutable(os.path.join(vdir, "receipt.json"), dumps(receipt))
    receipt["receipt"] = os.path.join(vdir, "receipt.json")
    return receipt


# ---------------------------------------------------------------- CLI

def build_parser():
    ap = argparse.ArgumentParser(prog="codex_pi.py", description=__doc__.split("\n")[0])
    ap.add_argument("--root", default=".", help="workspace root (state in ROOT/.codex-pi)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    notes = sub.add_parser("notes").add_subparsers(dest="action", required=True)
    s = notes.add_parser("save")
    s.add_argument("--session", required=True)
    s.add_argument("--file", required=True, help="notes JSON file, or - for stdin")
    r = notes.add_parser("read")
    r.add_argument("--session", required=True)
    r.add_argument("--revision", type=int)
    r.add_argument("--json", action="store_true")

    ho = sub.add_parser("handoff").add_subparsers(dest="action", required=True)
    ho.add_parser("prepare").add_argument("--session", required=True)
    ho.add_parser("list")
    r = ho.add_parser("read")
    r.add_argument("--id")
    r.add_argument("--json", action="store_true")
    c = ho.add_parser("consume")
    c.add_argument("--id", required=True)
    c.add_argument("--session", required=True)

    tk = sub.add_parser("ticket").add_subparsers(dest="action", required=True)
    o = tk.add_parser("open")
    o.add_argument("--title", required=True)
    o.add_argument("--problem", required=True)
    t = tk.add_parser("trial")
    t.add_argument("--id", type=int, required=True)
    t.add_argument("--approach", required=True)
    t.add_argument("--result", required=True)
    t.add_argument("--outcome", required=True, choices=OUTCOMES)
    rs = tk.add_parser("resolve")
    rs.add_argument("--id", type=int, required=True)
    rs.add_argument("--decision", required=True)
    rs.add_argument("--evidence", required=True)
    tk.add_parser("read").add_argument("--id", type=int, required=True)

    se = sub.add_parser("sessions").add_subparsers(dest="action", required=True)
    ls = se.add_parser("list")
    ls.add_argument("--dir")
    ls.add_argument("--limit", type=int, default=50)
    rd = se.add_parser("read")
    rd.add_argument("--file", required=True)
    rd.add_argument("--dir", help="archive root the file must resolve within")
    rd.add_argument("--offset", type=int, default=0)
    rd.add_argument("--limit", type=int, default=50)
    rd.add_argument("--max-chars", type=int, default=20000)
    sr = se.add_parser("search")
    sr.add_argument("--dir")
    sr.add_argument("--query", required=True)
    sr.add_argument("--limit", type=int, default=20)
    rg = se.add_parser("register")
    rg.add_argument("--session", required=True)
    rg.add_argument("--file", required=True)
    rg.add_argument("--dir", help="archive root the file must resolve within")

    v = sub.add_parser("verify")
    v.add_argument("--timeout", type=float, required=True)
    v.add_argument("--cwd")
    v.add_argument("argv", nargs=argparse.REMAINDER)
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    root = args.root
    out = sys.stdout
    try:
        key = (args.cmd, getattr(args, "action", None))
        if key == ("notes", "save"):
            if args.file == "-":
                raw = sys.stdin.buffer.read(NOTES_MAX_BYTES + 1)
            else:
                with open(args.file, "rb") as f:
                    raw = f.read(NOTES_MAX_BYTES + 1)
            res = save_notes(root, args.session, raw)
        elif key == ("notes", "read"):
            res = read_notes(root, args.session, args.revision)
            if not args.json:
                out.write(res["markdown"])
                return 0
        elif key == ("handoff", "prepare"):
            res = prepare_handoff(root, args.session)
        elif key == ("handoff", "list"):
            res = list_handoffs(root)
        elif key == ("handoff", "read"):
            res = read_handoff(root, args.id)
            if not args.json:
                out.write(render_handoff(res, os.path.abspath(root)))
                return 0
        elif key == ("handoff", "consume"):
            res = consume_handoff(root, args.id, args.session)
        elif key == ("ticket", "open"):
            res = ticket_open(root, args.title, args.problem)
        elif key == ("ticket", "trial"):
            res = ticket_trial(root, args.id, args.approach, args.result, args.outcome)
        elif key == ("ticket", "resolve"):
            res = ticket_resolve(root, args.id, args.decision, args.evidence)
        elif key == ("ticket", "read"):
            out.write(ticket_read(root, args.id))
            return 0
        elif key == ("sessions", "list"):
            res = list_sessions(args.dir, args.limit)
        elif key == ("sessions", "read"):
            res = read_session(args.file, args.offset, args.limit, args.max_chars, args.dir)
        elif key == ("sessions", "search"):
            res = search_sessions(args.query, args.dir, args.limit)
        elif key == ("sessions", "register"):
            res = register_transcript(root, args.session, args.file, args.dir)
        elif args.cmd == "verify":
            cmd = args.argv[1:] if args.argv[:1] == ["--"] else args.argv
            res = run_verify(root, cmd, args.timeout, args.cwd)
            out.write(dumps(res))
            return {"passed": 0, "failed": 1, "timeout": 124}.get(res["status"], 127)
        else:  # pragma: no cover
            raise CodexPiError("unknown command", 2)
        out.write(dumps(res))
        return 0
    except CodexPiError as e:
        sys.stderr.write(f"codex-pi: error: {e}\n")
        return e.code
    except OSError as e:
        sys.stderr.write(f"codex-pi: error: {e}\n")
        return 3


if __name__ == "__main__":
    sys.exit(main())
