# pi-canvas Goodies — component spec

Each goodie is ONE self-contained HTML file that pi-canvas inserts into a canvas frame (a sandboxed iframe, `allow-scripts`, no same-origin).

## Hard rules
- Pure HTML + CSS + vanilla JS (SVG / Canvas 2D / WebGL allowed). No frameworks, no build step.
- **No network at all**: no CDNs, no web fonts, no remote images. Use the system font stack
  `ui-sans-serif, -apple-system, "SF Pro Display", "Segoe UI", Inter, Roboto, sans-serif` (mono: `ui-monospace, "SF Mono", Menlo, monospace`).
  Images: draw with CSS gradients/SVG, or tiny inline SVG data URIs.
- Fill the iframe: `html,body{margin:0;height:100%}`; centre the component; it must look good at the manifest `w`×`h`
  and degrade gracefully when the frame is resized (use %, vw/vh, clamp()).
- Looks alive in a static preview: autoplay a gentle demo loop (e.g. a button shimmers, tabs auto-switch every ~2.5s,
  numbers roll) AND respond to real pointer/keyboard input. Stop the autoplay once the user interacts.
- Respect `prefers-reduced-motion: reduce` (stop loops, keep a nice static state).
- File size ≤ 14 KB. Readable code, short comment header:
  `<!-- pi-canvas goodie: <name>. Original implementation. Inspired by <source> (MIT) -->` (omit "Inspired by" if not applicable).
- **Original code only.** You may read the Reacticx React Native sources (MIT) under
  `/tmp/claude-0/-home-user-pi-canvas/0136e3fb-b044-5b5e-807d-e785924b1ed8/scratchpad/ext/reacticx/src/components/**`
  to understand what an effect looks/behaves like, but write a fresh web implementation — do not translate code line by line.
  Do not copy code from any other library or website.
- Quality bar: polished, modern product UI (think Apple / Linear / Vercel / Magic UI showcases). Careful spacing, real-looking
  copy (no lorem ipsum), smooth 60fps animations (transform/opacity, requestAnimationFrame), crisp on retina.
- Default to a dark stage (`#0a0a0b`-ish) unless the piece clearly reads better on light; set `bg` accordingly.
- No `alert()`, no `console.log` noise, no errors in the console.

## Files
- Put each file at `ui/public/goodies/<category>/<id>.html` (id = kebab-case).
- Write your manifest to `ui/public/goodies/manifest-<group>.json`: an array of
  `{ "id", "name", "category", "file": "<category>/<id>.html", "w", "h", "bg": "dark"|"light", "tags": [..],
     "description": "one sentence", "inspiredBy": "Reacticx · <component>" | null }`.
- Categories (use exactly): `buttons`, `inputs`, `text`, `loaders`, `cards`, `navigation`, `backgrounds`, `carousels`, `charts`, `blocks`.

## Verify before you finish
Render every file with Playwright (`require('playwright')` works; `chromium.launch()` needs no options) at the manifest size,
deviceScaleFactor 1, wait ~1.2s, assert no page errors / console errors, and look at a screenshot of each to judge quality.
Fix anything that looks broken, cramped, blank or generic. Save screenshots under
`/tmp/claude-0/-home-user-pi-canvas/0136e3fb-b044-5b5e-807d-e785924b1ed8/scratchpad/goodies-shots/<id>.png`.

Do not edit any other files in the repo, do not run git commands, do not install packages.
