# codex-pi

제공된 Codex CLI에 얹는 스킬 묶음입니다.

## 설치

프로젝트 루트에서:

```sh
git clone --depth 1 https://github.com/donghyeonan/codex-pi ~/.local/share/codex-pi
cp -R ~/.local/share/codex-pi/.agents .
cat ~/.local/share/codex-pi/AGENTS.block.md >> AGENTS.md
```

캔버스(`$canvas`)를 쓰려면:

```sh
node ~/.local/share/codex-pi/canvas/bin/codex-canvas.mjs install
```

Node.js 22.18 이상이 필요합니다. 설치 후 프로젝트에서 Codex를 재시작하고 `$canvas`를 입력하세요. MCP 설정이 클론 경로를 참조하므로 클론 폴더를 지우지 마세요. 원격 환경은 캔버스 포트 전달이 필요하며, 실시간 채팅은 같은 공유 app-server 데몬에서 실행 중인 Codex 세션에 연결됩니다.

최신 캔버스와 117개 예시·stageshow를 포함합니다. 공개 배포본에는 Pen 키트 데이터와 재배포 제한이 있는 transitions 스킬을 넣지 않습니다. 키트가 없어도 레이어·Goodies로 디자인할 수 있습니다.

## 스킬

| 스킬 | 설명 |
|---|---|
| `canvas` | `$canvas`로 http://127.0.0.1:3000 에 브라우저 캔버스를 엽니다. 데이터 시각화, 보고서, UI/UX 설계를 하며, 채팅은 터미널 Codex 세션과 같은 대화입니다 |
| `better-*`, `interface-review` | 캔버스 디자인 기준(레이아웃·타이포·색·UI·접근성·문구)과 완성 디자인 점검 |
| `stageshow` | UI/UX 작업 |
| `ponytail` | 항상(AGENTS.md). 가장 작은 완전한 변경 |
| `ponytail-review` | 제출 전 점검 |
| `problem-ledger` | 문제·개선을 `problem-hub/`에 티켓·시도·해결로 기록. "이어가"도 여기서 |
| `grilling` | 계획을 질문으로 다듬을 때 |
| `review` | "검토 에이전트 써"라고 할 때만 읽기 전용 서브에이전트 1개 |
| `peers` | 다른 작업의 기록·git 변경과 충돌 확인 |
| `explain` | 구현 기술 면접 대비 독립 HTML 해설 |
| `html-report` | 개념·자료를 블로그식 독립 HTML로 설명 |
| `humanize-korean` | "AI 티 없애줘": 한국어 문체만 다듬기 |
