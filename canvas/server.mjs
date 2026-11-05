#!/usr/bin/env node
// Run the pi-canvas workspace in the foreground: node canvas/server.mjs [--port 3000] [--host 0.0.0.0]
// Normally Codex starts it on demand through the canvas MCP server (see canvas/README.md).
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
if (opt("--port")) process.env.PI_CANVAS_PORT = opt("--port");
if (opt("--host")) process.env.PI_CANVAS_HOST = opt("--host");
if (args.includes("--workspace")) console.log("note: --workspace is no longer needed; documents live in $CODEX_HOME/pi-canvas");
if (!process.features?.typescript) {
  console.error(`canvas needs Node.js >= 22.18 (found ${process.version})`);
  process.exit(1);
}
await import("./src/codex/host.ts");
