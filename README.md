# codex-pi

제공된 Codex CLI에 얹는 작은 스킬 묶음입니다. 기본 설치는 Markdown 스킬과 AGENTS.md 몇 줄이며, 선택적으로 로컬 분석 캔버스를 실행할 수 있습니다. Codex 설정·인증·모델·권한은 그대로입니다.

## 설치

작업 폴더(프로젝트 루트)에서:

```sh
git clone --depth 1 https://github.com/donghyeonan/codex-pi /tmp/codex-pi && cp -R /tmp/codex-pi/.agents . && cat /tmp/codex-pi/AGENTS.block.md >> AGENTS.md
```

그다음 평소처럼 `codex`를 실행합니다. 설정·옵션 변경은 없습니다. 업데이트 안내가 뜨면 **Skip**을 고릅니다.

## 분석 캔버스 · 보고서

키트를 clone한 폴더에서 Node.js 22 이상으로 실행합니다. 별도 패키지 설치는 필요하지 않습니다.

```sh
node canvas/server.mjs --workspace /absolute/path/to/project
```

서버가 출력하는 `http://127.0.0.1:3000/#token=…` 주소를 엽니다. 캔버스에서는 산출물을 이동·크기 조절하고 메모하거나 표·차트 데이터를 선택해 대화에 보냅니다. **보고서** 탭에서는 같은 분석을 velog식 글로 읽고 독립 HTML로 저장합니다. HTML/JavaScript 산출물은 앱 권한과 분리된 sandbox에서 실행되며 외부 네트워크는 차단됩니다.

- 웹 채팅은 설치된 **Pi RPC / Codex app-server**를 지원합니다. 기본 `--agent auto`는 제공된 Codex 실행 맥락(`CODEX_THREAD_ID`) 또는 Codex만 있는 환경에서는 Codex, 그 외에는 로컬 Pi를 우선 선택합니다. `--agent pi|codex` 또는 입력창 아래 Agent 메뉴에서 고정할 수 있습니다. 인증·모델·권한 설정을 복사하거나 덮어쓰지 않습니다.
- 자료·배치는 공통이고 대화는 엔진별로 보존합니다(`thread.json`: 기존 Codex, `thread-pi.json` 및 `pi-sessions/`: Pi). 실행 중 전환과 다른 터미널의 Pi 세션 파일 재사용은 거부합니다. **New**는 기존 대화를 보관하고 새 대화를 시작하며, 상단 대화 목록에서 같은 엔진의 이전 세션으로 돌아갑니다(`conversation-*.json`). Pi 질문은 대화 안에서 답하고, 보관된 질문은 입력창의 Agent 메뉴 또는 `/q`로 다시 엽니다.
- CoFA처럼 제공된 Codex만 사용하는 환경은 `--agent codex`로 고정할 수도 있습니다. 실제 CoFA의 app-server 지원·포트 전달·시험 허용 여부는 현장 확인이 필요하며, 자동 감지를 플랫폼 검증으로 간주하지 않습니다.
- 터미널 Codex에는 `canvas` 스킬로 분석을 요청합니다. `.canvas/artifacts/`에 쓴 파일이 화면에 자동 반영됩니다. 웹과 터미널은 **파일을 공유하고 대화는 별개**입니다.
- 메모·배치는 `.canvas/`에 저장됩니다. 이 디렉터리에는 분석 내용과 대화 기록이 들어갈 수 있으므로 저장소에 포함할지는 프로젝트별로 정합니다.
- 채팅 연결이 없어도 산출물 탐색과 메모는 사용할 수 있습니다. 포트 충돌 시 `--port 3001`처럼 명시합니다.
- 채팅은 접힌 상태(하단 입력창)로 시작하고, 펼치면 왼쪽 패널이 됩니다. 패널의 `레퍼런스` 탭에서 함께 들어 있는 stageshow 예시 69개와 내 레퍼런스(`~/.codex-pi/refs/<분류>/<이름>.png`, 같은 이름 `.md` 메모 선택, `--refs <폴더>`로 변경)를 골라 다음 메시지의 기준으로 첨부합니다.
- Codex 0.165.0 실제 모델로 산출물 생성, 서버 종료 후 동일 대화 재개, 터미널 산출물 자동 반영, 선택 행 전달을 확인했습니다. 브라우저에서 HTML 스크립트 실행·앱/네트워크 격리, 메모·배치 유지, 보고서 HTML 저장과 독립 렌더를 확인했습니다.
- `node --test canvas/test/backend.test.mjs canvas/test/refs.test.mjs canvas/test/agents.test.mjs`: 모의 Pi/Codex 전환·재개·질문 응답, 접근 제어·중복 스트리밍·하위 폴더 경로 보호 검사 16개 통과. 로컬 Pi는 실제 RPC 접속과 모델 설정 읽기를 확인했으며, 이번 추가분의 실제 모델 응답·CoFA 실행은 미검증입니다.

Pi에서는 전역 `canvas` 스킬을 등록한 뒤 `/reload`하여 `/skill:canvas`로 사용할 수 있습니다. 스킬만 복사했을 경우 앱을 실행할 원본 clone도 필요합니다.

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
| `canvas` | 데이터 분석: 독립 HTML 원본 분석 보고서 먼저 → 가설·질문 → 필요 시 캔버스 시각화 |

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
