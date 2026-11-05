import { homedir } from "node:os";
import { join } from "node:path";

/** Codex's home directory (where config.toml, skills/ and the app-server daemon socket live). */
export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");
/** The app-server daemon's control socket: JSON-RPC over WebSocket. */
export const daemonSocket = () => join(codexHome(), "app-server-control", "app-server-control.sock");
/** pi-canvas state for Codex: documents, server.json, host.log. */
export const canvasDir = () => join(codexHome(), "pi-canvas");
export const serverFile = () => join(canvasDir(), "server.json");
export const DEFAULT_PORT = 3000;
