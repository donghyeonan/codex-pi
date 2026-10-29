---
name: explain
description: Use when the work is done and the user wants to understand the result before submitting ("설명 HTML", "이해도 점검"). Writes an HTML and Markdown walkthrough of the finished work.
---

# Explain

제출 뒤에는 제출물과 작업 기록으로 만든 질문에 AI 없이 직접 답해야 한다. 그 질문에 답할 수 있도록 결과물을 설명한다.

설명할 관점: 무엇을 만들었고 어떻게 동작하는가, 왜 이렇게 설계했는가(버린 대안과 이유), 실패하면 어디가 어떻게 깨지는가, 요구사항 대비 생략하거나 과하게 만든 것, 무엇으로 검증했는가, AI가 한 것과 사용자가 정한 것.

1. 실제 코드, `git log`/`git diff`, `.codex-pi/notes`, `.codex-pi/tickets`, 테스트 결과를 읽고 쓴다. 확인하지 못한 것은 확인하지 못했다고 쓴다.
2. [assets/template.html](assets/template.html)을 `.codex-pi/explain/index.html`로 복사해 채운다. CSS는 그대로 두고 필요한 부품만 쓴다.
   - 원문 블록 `.src`: 핵심 코드 대목을 `파일:줄`과 함께 그대로 보여 준다.
   - 내레이션 `.narration`: 영상 설명 스크립트처럼 소리 내 읽히는 문장으로, 기초부터 설명한다.
   - 흐름이 복잡하면 inline SVG 도식 하나.
3. 같은 내용을 `.codex-pi/explain/index.md`로도 쓴다.
4. 보기: `python3 -m http.server 8765 --bind 0.0.0.0 -d .codex-pi/explain`을 별도 터미널에서 실행하고 Browser 패널에서 포트 8765를 연다. 포트가 겹치면 다른 번호를 쓴다.
