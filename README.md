# codex-pi

제공된 Codex CLI에 얹는 작은 스킬 묶음입니다. 기본 설치는 Markdown 스킬과 AGENTS.md 몇 줄이며, 선택적으로 브라우저 캔버스(pi-canvas)를 MCP 서버 한 블록으로 추가합니다. Codex 인증·모델·권한은 그대로입니다.

## 설치

작업 폴더(프로젝트 루트)에서:

```sh
git clone --depth 1 https://github.com/donghyeonan/codex-pi /tmp/codex-pi && cp -R /tmp/codex-pi/.agents . && cat /tmp/codex-pi/AGENTS.block.md >> AGENTS.md
```

그다음 평소처럼 `codex`를 실행합니다. 설정·옵션 변경은 없습니다. 업데이트 안내가 뜨면 **Skip**을 고릅니다.

## 캔버스 (pi-canvas)

pen.dev 같은 브라우저 작업공간입니다. 보고서 화면, 자유롭게 이동·확대하는 디자인 캔버스, 그리고 **지금 Codex 터미널 세션과 같은 대화**인 채팅 패널이 있습니다. 웹에서 입력한 메시지는 터미널 Codex의 다음 메시지로 들어가고(작업 중이면 그 작업에 끼어듦), Codex의 답·도구 실행은 웹에 실시간으로 표시됩니다.

한 번만 설치합니다(Node.js **22.18 이상**, 패키지 설치 불필요). 위 설치 명령 다음에:

```sh
node /tmp/codex-pi/canvas/bin/codex-canvas.mjs install
```

`~/.codex/config.toml`에 `canvas` MCP 서버 한 블록(`# >>> pi-canvas` 표시 사이, 도구 자동 승인)만 추가합니다. 스킬은 위에서 복사한 `.agents/skills/`를 씁니다. 그다음 `codex`를 (다시) 실행합니다. clone한 위치(`/tmp/codex-pi`)는 지우지 않습니다.

Codex에서:

- `$canvas` → 작업공간이 **http://127.0.0.1:3000** 에 열립니다(첫 화면은 빈 캔버스). 포트가 사용 중이면 다음 빈 포트를 쓰고, 주소는 `node /tmp/codex-pi/canvas/bin/codex-canvas.mjs status`로 확인합니다.
- "README랑 csv 보고 분석해서 캔버스에 시각화해줘": 원자료 보고서(`canvas_report`, 섹션마다 캔버스 프레임)부터 만들고, 좌표·노선은 지도형 SVG 프레임, 핵심 숫자는 편집 가능한 카드로 캔버스에 올립니다. CDN·지도 타일 없이 동작합니다.
- "구성원이 배정 노선을 조회하는 웹앱 UI 잡아줘": `stageshow` 기준으로 모바일/데스크톱 프레임에 화면을 설계(`canvas_new`·`canvas_edit`)하고 스크린샷으로 확인한 뒤 구현합니다.
- 캔버스에서 레이어를 선택하고 채팅하면 선택한 요소·메모가 함께 전달됩니다(`<canvas_context>`).

참고:

- 문서는 `~/.codex/pi-canvas/`에 저장됩니다(프로젝트 폴더를 건드리지 않음). `codex-canvas.mjs stop`으로 끄고, `uninstall`로 설정 블록을 지웁니다.
- 실시간 대화 연결은 Codex TUI가 기본으로 쓰는 공유 app-server 데몬(`~/.codex/app-server-control/`)을 통합니다. 데몬 없이 실행된 세션이면 웹 채팅에 오프라인으로 표시되고, 보낸 메시지는 Codex가 다음에 캔버스 도구를 부를 때 전달됩니다.
- 브라우저가 다른 기기에 있는 원격 환경이면 Codex를 `PI_CANVAS_HOST=0.0.0.0 codex`로 실행하고 해당 포트를 전달합니다. 주소의 `?t=` 토큰까지 함께 엽니다.
- 직접 띄우려면 `node /tmp/codex-pi/canvas/server.mjs [--port 3000]`(포그라운드)로 실행합니다. 이때 웹 채팅은 가장 최근 Codex 세션에 붙습니다.
- 검증: Codex CLI 0.166.0 TUI + 모의 모델 + 브라우저로 `$canvas`, 3000번 포트, 터미널↔웹 메시지·스트리밍·작업 중 끼어들기·중지, 캔버스 편집, 이 키트의 설치 방식(`.agents` 복사 + MCP만 설치)을 자동 검사(35개)로 확인했습니다. 실제 모델과 CoFA 현장(포트 전달·config 수정 허용 여부)은 미검증입니다.
- `canvas/`는 pi-canvas(비공개 저장소)의 내보내기본입니다(`scripts/export-codex-pi.mjs`). 수정은 원본에서 합니다.

## 무엇이 들어 있나

| 스킬 | 쓰는 때 |
|---|---|
| `ponytail` | 항상(AGENTS.md). 가장 작은 완전한 변경 |
| `ponytail-review` | 제출 전 점검, 과설계 포함 |
| `problem-ledger` | 미해결 문제·개선: 티켓, 모든 시도(실패 포함), 검증된 해결을 `problem-hub/`에 기록. "이어가"도 여기서 |
| `stageshow` | UI/UX 작업 |
| `review` | "검토 에이전트 써"라고 할 때만 읽기 전용 서브에이전트 1개 |
| `explain` | 구현 기술 면접 대비: 실제 데이터 흐름·오류 처리·설계 선택·검증을 가르치는 독립 HTML |
| `peers` | 다른 작업의 Problem Hub 기록과 git 변경을 읽어 파일 충돌 확인 |
| `grilling` | 계획을 질문 라운드로 다듬을 때 |
| `humanize-korean` | "AI 티 없애줘", "번역투 고쳐": 내용·숫자·고유명사는 그대로 두고 한국어 문체만 다듬기, 검사 스크립트로 등급 확인 |
| `html-report` | 이해가 안 되는 것·새 개념·자료를 번호를 붙여 한 줄씩 이어 가는 블로그식 독립 HTML로 설명 (기본 Anthropic, 요청 시 velog 스타일) |
| `canvas` | `$canvas`: 데이터(README·CSV) 분석과 시각화, 보고서, 화면·웹앱 UI/UX를 브라우저 캔버스에서. 채팅은 터미널 세션과 같은 대화 |
| `better-*`, `interface-review` | 캔버스 디자인 기준(레이아웃·타이포·색·UI·접근성·문구)과 완성 디자인 점검 |

기록은 작업 폴더의 `problem-hub/`에 Markdown으로 남습니다(Node.js 22+, 추가 설치 없음). Pi의 Problem Hub와 같은 형식입니다.

```text
problem-hub/tickets/<PROJECT>-TICKET-NNN.md   티켓 (<project>#N, general#N)
problem-hub/attempts/ATT-*.md                 시도와 결과
problem-hub/resolutions/RES-*.md              검증된 해결
.codex-pi/explain/index.html                  구현 기술 면접 해설
```

## 컨텍스트 전환

`/status`의 `Context window: NN% left`가 적으면 진행 상황을 해당 티켓의 시도로 기록한 뒤 `/new` → "이어가 <티켓 번호>".

## 서브에이전트

Codex는 서브에이전트를 직접 요청하거나 AGENTS.md·스킬이 지시할 때만 띄웁니다. 이 키트는 자동 지시를 넣지 않았고, "검토 에이전트 써"라고 할 때만 `review` 스킬이 1개를 띄웁니다. 서브에이전트는 토큰을 따로 씁니다.

## 검증

2026-10-29, Codex CLI 0.164.0. 개인 설정·스킬이 없는 임시 HOME/CODEX_HOME에 GitHub에서 clone한 키트를 위 설치 명령으로 넣고 실제 모델로 `codex exec`를 돌렸습니다.

| 시험 | 모델 | 결과 |
|---|---|---|
| "메모 저장" 후 새 세션에서 "이어가 div" | Sol 6.1 | 메모의 next(`pow2`) 수행, 테스트 통과 |
| 다른 세션이 뭘 하는지 묻기 | Sol 6.1 | 다른 주제 메모 2개를 읽어 요약, 파일 수정 없음 |
| 실패 테스트를 티켓으로 관리하며 수정 | Sol 6.1 | `001-*.md`에 시도 2개·검증 명령, `resolved` |
| "검토 에이전트 써" | Sol 6.1 | `spawn_agent` 1개(`fork_turns: none`), 자식은 수정 없음 |
| 설명 HTML 요청 | Sol 6.1 | `index.html`·`index.md` 생성, 브라우저 렌더 확인 |

위 검증은 저장 경로 변경 전 결과입니다. 변경된 경로와 시험장 플랫폼에서의 실제 동작은 아직 검증하지 못했습니다.

## 출처

`grilling`(Matt Pocock), `ponytail`·`ponytail-review`(DietrichGebert)는 MIT 원본을 그대로 복사했습니다. [THIRD_PARTY.md](THIRD_PARTY.md)

### 컨텍스트 인계 알림

설치한 프로젝트에서 `node .agents/skills/problem-ledger/scripts/install-hooks.mjs` 실행 후 Codex의 `/hooks`에서 검토·승인합니다(git 작업 폴더와 hooks 지원 Codex 필요). 기존 훅은 보존합니다. 최근 요청 기준 사용량이 70%·80%에 도달할 때 각각 한 번 모델에게 메모 저장을 알리고(70% 미만으로 내려가면 초기화),, 새 세션에서는 작업별 최신 메모를 읽도록 안내합니다. Sol의 context_management 지원은 필요 없습니다. 사용량을 읽을 수 없으면 알리지 않으며, 자동 컨텍스트 교체나 메모 저장 강제 기능은 아닙니다.
