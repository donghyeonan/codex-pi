---
name: peers
description: Use when the user asks what another Codex session or terminal is doing, or before editing files another session may be working on.
---

# Peers

다른 세션의 기록은 여기서 본다. 읽기만 한다.

- `ls -t .codex-pi/notes/ | head` — 주제별 최신 메모. 다른 주제의 최신 파일을 읽는다.
- `grep -l '^status: open' .codex-pi/tickets/*` — 열린 티켓
- `git status --short`, `git diff --stat` — 아직 커밋 안 된 다른 세션의 변경

같은 파일을 건드리게 되면 사용자에게 먼저 알린다.
