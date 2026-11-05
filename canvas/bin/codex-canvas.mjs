#!/usr/bin/env node
// pi-canvas for the Codex CLI. Needs Node >= 22.18 (runs the TypeScript sources directly).
if (!process.features?.typescript) {
  console.error(`codex-canvas needs Node.js >= 22.18 (found ${process.version}); it runs the TypeScript sources directly.`);
  process.exit(1);
}
await import("../src/codex/cli.ts");
