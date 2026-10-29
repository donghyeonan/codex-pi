---
name: ticket
description: Use when a problem needs separate work across attempts (a bug, failing test, unclear requirement) or the user says "티켓". Not for trivial fixes.
---

# Ticket

티켓 하나당 `.codex-pi/tickets/NNN-<slug>.md` 하나. `NNN`은 기존 최대 번호 + 1.

```markdown
# #N <제목>
status: open
## Problem / success criterion
## Attempts
- 1) <가설·시도> → <결과> (<명령·근거>)
## Resolution
decision: ... / verification: `<명령>` <결과>
```

- 시도할 때마다 실패도 포함해 Attempts에 한 줄을 더한다.
- `status: resolved`는 검증 명령과 그 결과를 적을 때만 바꾼다.
- 열린 티켓: `grep -l '^status: open' .codex-pi/tickets/*`
