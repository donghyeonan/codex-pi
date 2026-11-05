---
name: problem-ledger
description: Use when the user presents an unresolved problem or improvement, says "티켓", or asks to continue earlier work. Records tickets, every trial and verified resolutions in ./problem-hub/.
---

# Problem ledger

Record with the recorder, never by hand-editing:

```sh
node .agents/skills/problem-ledger/scripts/record.mjs '<action JSON>'
```

1. Every newly presented unresolved problem or improvement needs a ticket before work. First list open tickets and reuse a matching one: `{"action":"list","query":"<terms>"}` (open only by default; add `"status":"all"` for history). Do not open tickets for completed work or ordinary conversation.
2. Open: `{"action":"open","scope":"project","title":"...","description":"<user goal and observable success criterion>","reportedBy":"user"}`. Use `"scope":"general"` when the problem is not about this project. The reply gives the reference (`<project>#N`); use it afterwards.
3. After each materially different attempt, record it, failures included: `{"action":"trial","ticket":"<ref>","approach":"...","result":"<observed result, command → output>","outcome":"failed|succeeded|inconclusive|abandoned|running"}`. Running is not succeeded.
4. Resolve only after verification or user acceptance: `{"action":"resolve","ticket":"<ref>","title":"...","decision":"...","result":"<verification command and result>"}`. Stopped work without a fix: `"action":"archive"`.
5. When continuing a ticket in a new session, add `{"action":"link-session","ticket":"<ref>","sourceSessions":["<session id>"]}`. Any write may carry `"sourceSessions"`.

## Continuing work

"이어가" or a new session: list open tickets, then read the ticket and its trials under `problem-hub/` (`grep -l '<ref>\|<ticket id>' -r problem-hub`). Trials keep detailed attempts and verification. On a context warning or save request, write goal/progress/decisions/next/ticket references to a new `problem-hub/context-notes/<task>/<timestamp>.md`; reference trials rather than duplicate them. On resume, read only the relevant task’s latest note plus its ticket; ask if ambiguous. Check `git status --short` for uncommitted work of other sessions before editing the same files.
