---
name: canvas
description: Use when analyzing a dataset or document collection, or when the user wants the local canvas/report. Raw analysis report first, then hypotheses and questions; visual design on the canvas.
---

# Data analysis → report → canvas

## Order

1. **Raw analysis, no conclusion yet.** Read everything given. Report what the data is: sources, units, fields, counts, distributions, missing/odd values, what stands out. Bar/donut/histogram charts of actual values. If a goal or README exists, note it but do not filter the raw picture through it.
2. **Report first.** A standalone HTML file, not a canvas artifact: `<workspace>/report/index.html`, opened directly in the browser. Raw tables (CSV/JSONL) get a linked viewer `report/tables.html`: search, filter, sort.
3. **Then branch:**
   - Goal given → hypotheses the raw picture allows for that goal, then `grilling` questions to align intent.
   - No goal → stop after the report. The user reads and decides a direction; then propose several hypotheses for it.
4. **Canvas only when visuals/design are needed** beyond the report: diagrams, maps, UI mockups (`stageshow`). Never put the report or its pieces on the canvas.

Never fabricate data, sources or checks. Every number traces to a file/row.

## Report

Follow the `html-report` skill (default Anthropic style): per section **원본** (data, charts, quoted passages, row links) | **해석** (basic explanation, what it means, uncertainty).

## Canvas files

Workspace = the analysis project. Write only `<workspace>/.canvas/artifacts/<id>.json` (temp file then rename); never edit `board.json`, `notes.json`, `thread*.json`. Keep stable ids; order with filename prefixes.

Required `id`, `title`, `type`; optional `facts`, `interpretation`, `sources` (`{label,url}`).
- `html`: `content` or local `src`
- `table`: `columns`, `rows`; `chart`: same + `chart: {kind: bar|line, x, y}`
- `markdown`: `content`; `image`: local `src`

Run from the codex-pi clone (three directories above this skill's real path): `node canvas/server.mjs --workspace <abs path>`, open the printed URL. Check an open port's workspace before reusing it.
