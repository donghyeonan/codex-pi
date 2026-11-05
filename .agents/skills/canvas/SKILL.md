---
name: canvas
description: Use when the user types $canvas, wants data (CSV/JSON, a task README) analyzed and visualized, wants a report, or wants a screen or web-app UI/UX designed. Everything is shown in the pi-canvas browser workspace (http://127.0.0.1:3000) whose chat panel is this same Codex session.
---

# canvas

pi-canvas is a pen.dev-style browser workspace (Report view, free design canvas, and a chat panel that IS this Codex session) driven by the `canvas` MCP tools: `canvas_open`, `canvas_report`, `canvas_new`, `canvas_edit`, `canvas_read`, `canvas_screenshot`, `canvas_kits`. If those tools are missing, tell the user to run `node <kit>/canvas/bin/codex-canvas.mjs install` (or `bin/codex-canvas.mjs install` in a pi-canvas clone) and restart Codex.

## $canvas alone

Call `canvas_open` and reply with the URL in one line. Mention that the chat there is this session. If no browser opened (remote machine), the user opens that URL; the port must be forwarded (`PI_CANVAS_HOST=0.0.0.0` when started from a container).

## Data → understanding → visuals (CSV, coordinates, schedules …)

1. **Read everything first.** The README/task statement and every data file: fields, units, row counts, keys that join files, missing/odd values. Use quick shell/Node/Python checks. Never invent data; every number must trace to a file and row.
2. **Raw picture as a report.** One `canvas_report`: a `<section>` per part (dataset overview, each file, distributions, what stands out, the task's goal and constraints). Inline SVG charts of actual values, no conclusions yet. Each section becomes a frame on the canvas. When `html-report` is available, follow its numbered blog-style flow (default Anthropic style): put each chart, quoted passage or row link beside the number that uses it, with `한줄 코멘트.` blocks for interpretation and uncertainty.
3. **Visuals on the canvas.** `canvas_new` (or add frames next to the report frames) and build one frame per question:
   - Coordinates/maps: a frame whose `html` is a self-contained SVG/JS view: scale x/y or lat/lng to the frame, points coloured by group, routes as polylines with order arrows, stop labels, legend, hover tooltips. Embed the data in the page. **No CDN, no map tiles** (the network may be blocked).
   - Big data: write the page to a file (e.g. `.canvas/route-map.html`) and add the frame with `node.htmlPath` instead of inline `html`.
   - KPI cards and short tables as native layers (frame + text/rect, flex `layout`) so the user can move and edit them; charts as inline SVG.
   - Name frames by what they answer; put assumptions in the layer `context`.
   - `canvas_screenshot` every new frame and fix what looks wrong before saying done.
4. **Goal given:** state the hypotheses and the plan the data supports (e.g. route assignment rules), ask the open questions, then show the result as frames (before/after, per-route maps, load per route).

## Web app UI/UX

Design on the canvas before coding. Read the bundled `stageshow` skill for UI/UX taste and the relevant `better-*` skills. If stageshow is missing, check the installation's skill scope rather than assuming it is bundled into every running session. Then:

1. `canvas_new` with device frames (e.g. mobile 390x844 for "look up my assigned route", desktop for an admin view), one frame per screen/state (empty, loading, result, error).
2. Build with native layers through `canvas_edit` (frames with flex `layout`, text, rect, icon, image; `isComponent` for repeated cards; `set_variables` for colours). Use real data from the files for sample content. Use `canvas_kits` to list installed design kits before choosing one; the public codex-pi bundle intentionally excludes Pen kit data, so an empty list is normal and layers/Goodies remain available.
3. `canvas_screenshot` and refine. When the user approves, implement the app in code to match the frames (the frames' Code panel gives HTML/Tailwind as a starting point).

## Messages from the browser

Live chat requires this terminal session to remain open in Codex's shared app-server daemon. If the workspace reports offline/queued, do not claim the browser message reached the live session; call a canvas tool from the intended terminal session to check attachment. Do not resume an unrelated thread or create a second writer of its session file.

A user message ending with `<canvas_context doc=… view=…>` was typed in the canvas. Call `canvas_read` for that document first, then change it with `canvas_edit` (`replace_in_report` for small report edits, `set_report` for rewrites, `add`/`update`/`delete` for layers). Respect the selected layers' context notes, and treat unresolved canvas comments as the user's feedback. Do not edit the stored document files with shell or patch tools.
