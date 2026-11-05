---
name: html-report
description: Use when making an HTML report, source reader or analysis write-up. 원문·원본을 그대로 보여 주고 해석을 나란히 붙인 독립 HTML; 기본 Anthropic 스타일, 요청 시 velog 스타일.
---

# HTML Report

독자가 원문·원본을 직접 보고, 해석은 옆에서 기초부터 따라가게 한다.

## 스타일

- **기본: Anthropic** — [templates/anthropic.html](templates/anthropic.html). 아이보리 배경, 세리프 제목, 오렌지톤 강조, 원본|해석 두 칸. 완성 예: [references/anthropic-example.html](references/anthropic-example.html).
- **velog** (요청 시) — [templates/velog.html](templates/velog.html). 흰 배경, 768px 한 칸, 민트 강조. 시각 비교: [references/velog-pen-imported-page.html](references/velog-pen-imported-page.html).
- 고정하는 것은 시각 스타일뿐이다. 목차·순서·서술 형식은 요청에 따른다. 예시의 주제·내용을 복사하지 않는다. 별도 요청 없이 재디자인하지 않는다.

## 구성

- **원본 | 해석**: 절마다 왼쪽에 원본(데이터·그래프·원문 대목·출처), 오른쪽에 해석. 좁은 화면에선 한 칸으로 쌓는다. velog는 원문 블록 → 해석 순서로 교차.
- 절 제목 아래 **핵심 한 줄**(원본이 보여 주는 것).
- 원문은 그대로, 생략은 `[중략]`. 외국어는 번역을 본문에, 원문은 `details`에.
- 그림은 원본 이미지 우선, 캡션에 볼 점과 출처. 새로 그린 도식은 `AI 보충 도식`. 그래프는 실제 값으로 inline SVG.
- 해석은 기초 개념부터. 출처가 여럿이면 `(A1)` 링크로 근거를 단다. 단서·한계는 필요한 곳에 한 번.
- 원본 표(CSV/JSONL)는 검색·정렬되는 하위 페이지로 링크한다.
- 내부 그래픽·UI 시연은 `stageshow`.

## 저장·확인

독립 `.html` (이미지 data URI, CDN·외부 요청 없음). 원문 인용·수치를 출처와 대조하고, 브라우저에서 데스크톱·모바일 폭을 열어 넘침·가독성을 본다.
