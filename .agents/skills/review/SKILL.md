---
name: review
description: Use only when the user explicitly asks for a review agent or subagent ("검토 에이전트 써"). Spawns one read-only reviewer.
---

# Review

1. 범위를 정한다: 요구사항 문서 경로, 검토할 변경(`git diff` 범위나 파일), 확인 명령.
2. `spawn_agent` 하나를 `fork_turns: "none"`으로 띄우고 위 범위를 전부 담아 지시한다: 파일을 수정하지 말 것, `.agents/skills/ponytail-review/SKILL.md`를 따라 검토할 것, 요구사항 누락도 볼 것, 실행한 명령과 결과를 함께 돌려줄 것.
3. 결과를 그대로 믿지 않는다. 지적마다 코드를 직접 확인하고, 결정적인 테스트 명령은 직접 다시 실행한다.
4. 사용자에게 확인된 문제, 근거 없는 지적, 다음 조치를 나눠 알린다.
