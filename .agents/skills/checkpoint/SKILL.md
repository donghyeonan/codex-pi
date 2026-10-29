---
name: checkpoint
description: Use when saving or resuming work across /new or a new context window ("메모 저장", "이어가", an important decision, failure or verification result, or little context left).
---

# Checkpoint

## 저장

`.codex-pi/notes/<주제>-<YYMMDD-HHMM>.md`를 **새 파일**로 쓴다. 덮어쓰지 않으므로 이전 파일이 이력이 된다. `<주제>`는 이 세션 작업을 나타내는 짧은 영문 slug로, 세션 내내 같은 값을 쓴다. 시각은 `date +%y%m%d-%H%M`.

```markdown
# <주제> <시각>
goal: 사용자 목표와 성공 기준
constraints: 지켜야 할 조건
decisions: 결정 — 이유 한 줄
progress: 검증된 것(명령 → 결과), 바뀐 파일
failed: 시도했다 실패한 것 — 원인
next: 다음 행동 하나와 남은 확인
refs: 과제 문서·티켓·핵심 파일 경로
window: 현재 context window id (있을 때만)
```

이전 메모의 유효한 결정은 빠짐없이 옮긴다. 이 파일만 읽어도 이어갈 수 있어야 한다.

저장 시점: 사용자 요청, 중요한 결정·실패·검증 결과 직후, 남은 컨텍스트가 적을 때. 저장했다는 이유로 `/new`를 권하지 않는다.

## 이어가기 ("이어가 [주제]")

1. `ls -t .codex-pi/notes/`에서 그 주제의 최신 파일을 읽는다. 주제를 말하지 않았는데 최근 주제가 둘 이상이면 어느 쪽인지 묻는다.
2. `git status --short`와 관련 파일로 메모가 현재 상태와 맞는지 확인한다.
3. `next`부터 계속한다.

## new_context 도구가 있을 때

남은 컨텍스트(`get_context_remaining`)가 20% 아래면 작업 경계에서 위 형식으로 저장한 뒤 `new_context`를 호출한다. `new_context`는 `exec` 스크립트 안의 `tools.*`가 아니라 직접 도구 호출(`functions.new_context`)이다. 새 창에서는 `grep -l <Previous context window id> .codex-pi/notes/*`로 찾은 메모의 최신 파일부터 읽고 `next`를 이어간다. 내장 `notes`·`history` 도구가 실패해도 이 파일로 이어간다.
