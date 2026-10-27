# codex-pi

제공된 **Codex CLI를 그대로** 사용하는 로컬 작업 기록 도구. Python 3.10+ 표준 라이브러리만 사용합니다. 별도 모델·API 키·서버·데이터베이스가 없습니다. 자동 새 대화 대신 사용자가 `/new` → `이어가`로 전환합니다.

## 설치

저장소를 clone한 뒤 작업 폴더에서 실행합니다. 아래 `0.8`은 **선택 가능한 예시 운영값**이지 모델 성능 보장선이 아닙니다.

```sh
python3 /path/to/codex-pi/setup_workspace.py --root . --ratio 0.8 --window-cap 512000
```

설치 범위는 해당 작업 폴더뿐입니다.

- `.agents/skills/`: codex-pi, grill-me, grilling
- `.codex/hooks.json`: SessionStart/Stop 훅 추가; 기존 훅 유지
- `AGENTS.md`: 기존 내용 유지, 진입 지침 3줄 추가
- `.codex-pi/`: 설정·기록·설치 전 백업. Git에서 제외됨

기존 Codex를 이 작업 폴더에서 열어 프로젝트 신뢰 여부를 확인하고 **`/hooks`에서 두 훅을 검토·신뢰**하세요. clone만으로 설치·훅 신뢰가 자동 완료되지는 않습니다. 플랫폼이 프로젝트 훅을 금지하면 설치하지 마세요. 관리 설정·인증·모델·감독 프로세스를 바꾸거나 신뢰 확인을 우회하지 않습니다. 현재 CLI 0.164.0 문서/프로토콜을 대상으로 하며 다른 버전과 Cofa 현장 호환성은 별도 확인이 필요합니다.

상태바는 `/statusline`에서 `context-remaining`, `context-window-size`를 고르거나 다음 실행 파일을 사용합니다.

```sh
/path/to/codex-pi/run-codex
```

이는 같은 `codex` 명령에 상태바 표시 옵션만 추가합니다. 실제 모델 용량 기준 표시이며 아래 운영 상한과는 다릅니다. 이미 실행 중인 대화의 표시 설정을 강제로 바꾸지 않습니다.

## 컨텍스트

중요한 결정·실패·검증 결과에는 상한 전이라도 메모를 저장합니다. **저장했다는 이유만으로 전환을 권하지 않습니다.**

전환 기준은 `min(Codex 보고 용량, 운영 상한) × 비율`입니다. 예를 들어 512,000 상한·80%면 최대 409,600토큰에서 안내합니다. 실제 보고 용량이 486,400이면 389,120토큰에서 안내합니다. 설정은 `.codex-pi/config.json`의 `context_ratio`, `context_window_cap`; 별도 절대 임계치 `context_tokens`도 선택할 수 있습니다.

Stop 훅은 마지막 요청의 `last_token_usage.total_tokens`와 `model_context_window`를 읽습니다. 누적 과금 토큰을 쓰지 않습니다. 보고 시점 이후 메시지가 추가될 수 있으므로 점유량은 근사치입니다. 정보가 없으면 unknown이며 수치를 추측하지 않습니다. 작업 턴 종료 경계에서만 검사하므로, 한 번의 긴 턴 안에서 먼저 발생하는 내장 자동 압축/초과를 막지는 못합니다.

```text
중요한 변화 → 메모 저장 (전환 안내 없음)
임계치 도달 → 세션당 한 번 메모 갱신·인계 준비 요청
저장 성공 확인 → 사용자 /new → 이어가
새 대화 → 인계 메모 읽기 → 현재 파일 확인 → 인계 소비 → 계속
```

메모 작성은 AI가 수행합니다. 훅이 직접 요약하거나 저장 성공을 보장하지 않습니다. 저장 실패 시 현재 대화를 유지하고 실패를 알립니다. 무한 재시도는 없습니다. `/new` 이후 자동 파일 주입이 아니라 지침에 따른 읽기이며, 실제 현장 동작을 먼저 확인하세요.

메모 필드: `goal`, `constraints`, `decisions`, `progress`, `next`, `references`. 이전 유효 결정을 보존하여 전체 갱신하며, 세션별 latest와 불변 history를 남깁니다. 인계는 특정 revision을 고정합니다. 준비 후 새 메모가 생기면 재준비해야 합니다. **메모에 반영하지 않은 추가 작업까지 자동으로 감지하지는 못하므로 `/new` 직전에 최신화**하세요. 여러 인계가 대기 중이면 사용자가 고릅니다.

## 로컬 기록 도구

```sh
python3 /path/to/codex-pi/codex_pi.py --root . --help
python3 /path/to/codex-pi/codex_pi.py --root . handoff list
python3 /path/to/codex-pi/codex_pi.py --root . sessions list
python3 /path/to/codex-pi/codex_pi.py --root . ticket list
python3 /path/to/codex-pi/codex_pi.py --root . verify --timeout 60 -- python3 -m unittest discover -s tests
```

- `notes save/read`: 최신 메모와 revision 이력
- `handoff prepare/list/read/consume`: `/new` 전후의 명시적 인계
- `sessions list/search/read/register`: 본인 로컬 Codex `.jsonl` 대화·도구 원문. `--dir`로 조회 범위를 지정할 수 있습니다. 요약하지 않으며 reasoning·불투명 payload·인증 메타데이터는 제외. 원문 도구 출력 자체에는 민감정보가 있을 수 있으므로 외부로 보내지 마세요. 기본 출력에서 잘린 대목은 `--max-chars 0`과 작은 `--limit`으로 다시 읽습니다.
- `ticket open/trial/resolve/read/list`: 티켓 하나당 Markdown 하나. 문제·결정·시도·관측 결과·검증 근거를 누적
- `verify`: 명령 한 번 실행, 제한시간·종료코드·출력·실행 전후 상태 기록. **명령 성공과 요구사항 충족은 별개**이며 전체 Git 상태 해시는 모델 품질 검증이 아닙니다.

실제 기록은 `.codex-pi/`에만 둡니다. 공개 저장소에 시험 문제·대화·기록·키를 올리지 마세요. 이 도구에는 원격 업로드 기능이 없습니다.

## grill-me / Franky 대안

`grill-me`는 Matt Pocock의 원본 `grilling`을 읽는 짧은 Codex 어댑터입니다. 원본 지침과 MIT 라이선스는 보존했습니다. [출처](THIRD_PARTY.md).

이 저장소를 못 가져올 때는 공개 Superloopy 저장소의 Franky 지침을 직접 읽을 수 있습니다.

```sh
git clone https://github.com/beefiker/superloopy.git
```

해당 버전의 `agents/franky.md`를 먼저 확인하세요. **Franky는 구현·증거 작성 지침**이고 Superloopy의 `begin/check/finish`는 별도 실행 코드입니다. Franky 파일만 읽는다고 검증 루프나 전용 도구가 설치되지는 않습니다. 제공 Codex에서 사용할 수 없는 도구 이름·모델 지정은 그대로 실행하라고 지시하지 마세요. 안전하고 반복 가능한 테스트 명령의 실제 결과로 검증하고, 지원하지 않는 부분을 명시하세요. 플랫폼의 외부 자료 규칙은 어느 저장소에도 동일하게 적용됩니다.

## 검증

```sh
python3 -m unittest discover -s tests -v
```

현재 단위·회귀 테스트 53개가 통과했습니다. 로컬 Git clone → 개인 설정·스킬·이력 없는 프로필 설치 → 실제 Codex 0.164.0 / gpt-6.1-sol의 두 대화에서 체크포인트 저장과 `이어가` 복원을 확인했습니다. 첫 대화에서 보류한 파일 작업을 두 번째 대화가 수행했고, 다른 세션 ID로 인계가 소비됐습니다. 훅은 native 신뢰 UI에서 검토 후 활성화했으며 테스트 인증 사본은 제거했습니다.

이 실모델 시험은 작은 임계치를 사용한 두 `codex exec` 대화입니다. TUI의 `/new`와 상태바 표시는 별도로 확인했지만, 문자 그대로의 TUI `/new` 전후 인계 전체를 시험한 것은 아닙니다. 512K 길이의 실부하·모델 품질·Cofa 현장의 승인/기록 수집 호환성은 검증하지 않았습니다.
