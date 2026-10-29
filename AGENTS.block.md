
## codex-pi
- 구현은 `ponytail` 스킬(full)을 따른다. `ponytail-review`는 제출 전이나 요청할 때만 쓴다.
- "메모 저장"·"이어가", 중요한 결정·실패·검증 결과에는 `checkpoint` 스킬로 `.codex-pi/notes/`에 메모를 새로 쓰거나 읽는다.
- 여러 시도가 필요한 문제는 `ticket`, 다른 세션 기록은 `peers`, "검토 에이전트 써"는 `review`, 완성 후 설명은 `explain` 스킬.
- 새 context window에서 시작했으면(Previous context window id가 있으면) 먼저 `checkpoint` 스킬대로 내 메모를 찾아 읽고 이어간다.
