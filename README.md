# codex-pi

제공된 Codex CLI에 얹는 작은 스킬 묶음입니다. 코드·훅·서버 없이 Markdown 스킬과 AGENTS.md 몇 줄뿐입니다. clone해서 복사하면 끝이고 Codex 설정·인증·모델은 그대로입니다.

## 설치

작업 폴더(프로젝트 루트)에서:

```sh
git clone --depth 1 https://github.com/donghyeonan/codex-pi /tmp/codex-pi && cp -R /tmp/codex-pi/.agents . && cat /tmp/codex-pi/AGENTS.block.md >> AGENTS.md
```

그다음 평소처럼 `codex`를 실행합니다. 설정·옵션 변경은 없습니다. 업데이트 안내가 뜨면 **Skip**을 고릅니다.

## 무엇이 들어 있나

| 스킬 | 쓰는 때 |
|---|---|
| `ponytail` | 항상(AGENTS.md). 가장 작은 완전한 변경 |
| `ponytail-review` | 제출 전 점검, 과설계 포함 |
| `checkpoint` | "메모 저장", "이어가 [주제]", 중요한 결정·실패·검증 |
| `peers` | 다른 터미널의 Codex 세션이 뭘 하는지 볼 때 |
| `ticket` | 여러 번 시도할 문제를 티켓 하나당 파일 하나로 기록 |
| `review` | "검토 에이전트 써"라고 할 때만 읽기 전용 서브에이전트 1개 |
| `explain` | 완성 후, 후속 질문 관점으로 결과물을 설명하는 HTML + MD |
| `grilling` | 계획을 질문 라운드로 다듬을 때 |

기록은 모두 작업 폴더의 `.codex-pi/`에 남습니다.

```text
.codex-pi/notes/<주제>-<YYMMDD-HHMM>.md   메모(매번 새 파일 = 이력)
.codex-pi/tickets/NNN-<slug>.md            티켓
.codex-pi/explain/index.html, index.md     설명
```

## 컨텍스트 전환

기본: `/status`의 `Context window: NN% left`를 보고 "메모 저장" → `/new` → "이어가". 두 세션을 쓰면 "이어가 <주제>".

선택(자동 전환): Codex에 내장된 `new_context`는 Sol 6.0·Luna 6에서만, 실험 기능을 켰을 때 나타납니다.

```sh
codex -c model=gpt-6-sol -c features.context_management.experimental_mode=true
```

켜지면 AI가 남은 컨텍스트 20% 아래에서 메모를 저장하고 스스로 새 창으로 넘어가 메모를 읽고 이어갑니다. 다만 `-c`를 붙이면 Codex가 평소의 공유 백그라운드 서버(`/status`의 `Server`) 대신 자체 내장 서버로 실행된다는 경고가 뜹니다. 시험장에서는 사전 체험 때 이 명령이 동작하는지, 써도 되는지 Cofa Helper에 확인한 뒤에만 쓰세요. 아니면 기본 방식을 씁니다.

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
| 1단계 후 `new_context`, 2단계는 새 창에서 | Sol 6.0 + 실험 기능 | 새 창에서 이전 창 id로 메모를 찾아 2단계 완료, 테스트 통과 |

실험 기능의 내장 `notes`·`history` 도구는 이 시험에서 `backend request failed`를 냈습니다. 그래서 메모는 작업 폴더 파일로 둡니다. 시험장 플랫폼에서의 동작과 기록 수집은 확인하지 못했습니다.

## 출처

`grilling`(Matt Pocock), `ponytail`·`ponytail-review`(DietrichGebert)는 MIT 원본을 그대로 복사했습니다. [THIRD_PARTY.md](THIRD_PARTY.md)
