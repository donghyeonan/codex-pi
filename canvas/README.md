# canvas (pi-canvas)

Exported from pi-canvas 0.1.0 by `scripts/export-codex-pi.mjs`; edit there, not here.

- `src/codex/mcp.ts`: MCP server Codex starts (tools `canvas_open`, `canvas_report`, `canvas_new`, `canvas_edit`, `canvas_read`, `canvas_screenshot`)
- `src/codex/host.ts`: the workspace (http://127.0.0.1:3000) and the bridge into the live Codex session (app-server daemon)
- `bin/codex-canvas.mjs`: `install`, `status`, `open`, `stop`, `uninstall`
- `src/index.ts`: the same workspace as a pi extension
- `web/`: the built browser UI (Preact), including the goodies components
