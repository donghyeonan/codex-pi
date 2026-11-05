# codex-pi

제공된 Codex CLI에 얹는 스킬 묶음과 브라우저 캔버스입니다. Codex 인증·모델·권한은 그대로입니다.

## 설치

프로젝트 루트에서:

```sh
git clone --depth 1 https://github.com/donghyeonan/codex-pi /tmp/codex-pi && cp -R /tmp/codex-pi/.agents . && cat /tmp/codex-pi/AGENTS.block.md >> AGENTS.md
```

캔버스도 쓰려면(Node.js 22.18+, `~/.codex/config.toml`에 MCP 블록 하나 추가):

```sh
node /tmp/codex-pi/canvas/bin/codex-canvas.mjs install
```

그다음 `codex`를 실행합니다. 업데이트 안내가 뜨면 **Skip**을 고릅니다.

## 캔버스

`$canvas` → **http://127.0.0.1:3000** 에 pen.dev 같은 작업공간이 열립니다. 채팅 패널은 **지금 터미널의 Codex 세션과 같은 대화**입니다.

- "README랑 csv 분석해서 시각화해줘" → 원자료 보고서 + 지도·차트·KPI 카드 프레임
- "배정 노선 조회 웹앱 UI 잡아줘" → 모바일/데스크톱 프레임에 화면 설계(`stageshow`) 후 구현
- 캔버스에서 요소를 선택하고 채팅하면 그 요소가 함께 전달됩니다.

| 명령 (`node /tmp/codex-pi/canvas/bin/codex-canvas.mjs …`) | 용도 |
|---|---|
| `status` | 주소·연결 상태 (3000이 사용 중이면 다음 빈 포트) |
| `stop` / `uninstall` | 끄기 / 설정 블록 제거 |

원격 환경이면 `PI_CANVAS_HOST=0.0.0.0 codex`로 실행하고 포트를 전달한 뒤 `?t=` 토큰이 붙은 주소를 엽니다. 문서는 `~/.codex/pi-canvas/`에 저장됩니다.

## 스킬

| 스킬 | 쓰는 때 |
|---|---|
| `canvas` | 데이터 시각화·보고서·UI/UX를 브라우저 캔버스에서 |
| `better-*`, `interface-review` | 캔버스 디자인 기준과 완성 디자인 점검 |
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

## 컨텍스트 전환

`/status`의 `Context window`가 적으면 진행 상황을 티켓 시도로 기록 → `/new` → "이어가 <티켓 번호>".
알림을 원하면 `node .agents/skills/problem-ledger/scripts/install-hooks.mjs` 실행 후 Codex `/hooks`에서 승인합니다(사용량 70%·80%에서 메모 저장 안내).

## 검증

- 스킬: Codex CLI 0.164.0 + 실제 모델(`codex exec`)로 메모·이어가기·티켓·검토 에이전트·설명 HTML 확인.
- 캔버스: Codex CLI 0.166.0 TUI + 모의 모델 + 브라우저로 자동 검사 35개 통과.
- 실제 시험장(CoFA) 동작은 미검증입니다.

## 출처

외부 스킬과 `canvas/`(pi-canvas 내보내기본)의 출처·라이선스는 [THIRD_PARTY.md](THIRD_PARTY.md)에 있습니다.
