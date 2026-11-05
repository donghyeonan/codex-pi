/**
 * pi-canvas MCP server for the Codex CLI (stdio, newline-delimited JSON-RPC).
 *
 * Codex starts one of these per session. It owns no state: each tool call is forwarded to the pi-canvas
 * host (src/codex/host.ts, started on demand, one per CODEX_HOME) together with the calling thread id that
 * Codex puts in the request `_meta`, so the host can join that live session for the browser chat.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { NODE_DOC, OP_NAMES, TOOL_TEXT } from "../core.ts";
import { canvasDir, serverFile } from "./paths.ts";

const HOST = join(dirname(fileURLToPath(import.meta.url)), "host.ts");
const VERSION = "0.1.0";

const str = (description: string) => ({ type: "string", description });
const view = { type: "string", enum: ["report", "canvas"], description: "Initial view (default report)" };

export const TOOLS = [
	{
		name: "canvas_open",
		description:
			"Open the pi-canvas browser workspace (default http://127.0.0.1:3000): Report view, design Canvas, and a chat panel that is this same Codex session. Opens the active (or given) document, or the empty workspace. Use when the user invokes $canvas or asks to open/show the canvas.",
		inputSchema: { type: "object", properties: { docId: str("Document to show (default: the active one)"), view }, additionalProperties: false },
		annotations: { title: "Open canvas", readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "canvas_report",
		description: TOOL_TEXT.canvas_report.description,
		inputSchema: {
			type: "object",
			properties: { title: str("Document title"), html: str("Complete HTML document"), path: str("Path to an existing HTML file (relative to cwd)"), docId: str("Existing document to replace the report of"), view },
			required: ["title"],
			additionalProperties: false,
		},
		annotations: { title: "Show HTML report", openWorldHint: false },
	},
	{
		name: "canvas_read",
		description: TOOL_TEXT.canvas_read.description,
		inputSchema: { type: "object", properties: { docId: str("Document id (default: active document)"), full: { type: "boolean", description: "Include full HTML (default false)" } }, additionalProperties: false },
		annotations: { title: "Read canvas document", readOnlyHint: true, openWorldHint: false },
	},
	{
		name: "canvas_edit",
		description: TOOL_TEXT.canvas_edit.description,
		inputSchema: {
			type: "object",
			properties: {
				docId: str("Document id (default: active document)"),
				ops: {
					type: "array",
					description: "Operations, applied in order",
					items: {
						type: "object",
						properties: {
							op: { type: "string", enum: [...OP_NAMES], description: "Operation" },
							id: str("Node or comment id (update, delete, replace_in_node, update_comment, delete_comment)"),
							node: { type: "object", description: NODE_DOC, additionalProperties: true },
							props: { type: "object", description: "update / update_comment: fields to change (null removes a field)", additionalProperties: true },
							html: str("set_report: full new report HTML"),
							htmlPath: str("set_report: read the new report HTML from this file instead"),
							find: str("replace_*: exact text to find"),
							replace: str("replace_*: replacement text"),
							all: { type: "boolean", description: "replace_*: replace every occurrence (default first only)" },
							title: str("set_title: new document title"),
							variables: { type: "object", additionalProperties: { type: "string" }, description: "set_variables: name -> value (e.g. primary -> #4f46e5); use as \"$primary\" in colors" },
							comment: { type: "object", description: "add_comment: {text, x, y, nodeId?}", additionalProperties: true },
							ids: { type: "array", items: { type: "string" }, description: "set_slide_order: top-level frame ids in presentation order" },
						},
						required: ["op"],
					},
				},
			},
			required: ["ops"],
			additionalProperties: false,
		},
		annotations: { title: "Edit canvas document", destructiveHint: false, openWorldHint: false },
	},
	{
		name: "canvas_new",
		description: TOOL_TEXT.canvas_new.description,
		inputSchema: {
			type: "object",
			properties: {
				title: str("Document title"),
				frames: {
					type: "array",
					description: "Empty frames to create, left to right",
					items: {
						type: "object",
						properties: {
							name: str("Frame name"),
							w: { type: "number", description: "Width (overrides the preset)" },
							h: { type: "number", description: "Height (overrides the preset)" },
							preset: { type: "string", enum: ["desktop", "tablet", "mobile"], description: "desktop 1440x1024 (default), tablet 834x1194, mobile 390x844" },
						},
					},
				},
			},
			required: ["title"],
			additionalProperties: false,
		},
		annotations: { title: "New canvas design", openWorldHint: false },
	},
	{
		name: "canvas_kits",
		description: TOOL_TEXT.canvas_kits.description,
		inputSchema: {
			type: "object",
			properties: {
				kit: str("Design kit name (omit to list bundled kits)"),
				component: str("Exact component name or kit id to inspect"),
				insert: { anyOf: [{ type: "string", const: "all" }, { type: "array", items: { type: "string" } }] },
				docId: str("Document id (default: active document)"),
				x: { type: "number" },
				y: { type: "number" },
				theme: str("Light (default) or Dark, case insensitive"),
			},
			additionalProperties: false,
		},
		annotations: { title: "Canvas kits", destructiveHint: false, openWorldHint: false },
	},
	{
		name: "canvas_screenshot",
		description: TOOL_TEXT.canvas_screenshot.description,
		inputSchema: {
			type: "object",
			properties: { docId: str("Document id (default: active document)"), nodeId: str("Frame or layer id (default: the whole document)"), scale: { type: "number", minimum: 1, maximum: 2, description: "Pixel scale, 1 or 2 (default 1)" } },
			additionalProperties: false,
		},
		annotations: { title: "Screenshot canvas", readOnlyHint: true, openWorldHint: false },
	},
];

export const INSTRUCTIONS = [
	"pi-canvas shows HTML reports and designs in a browser workspace whose chat panel is this same Codex session.",
	"When the user invokes $canvas or asks to open the canvas, call canvas_open.",
	...TOOL_TEXT.canvas_report.guidelines,
	...TOOL_TEXT.canvas_new.guidelines,
	...TOOL_TEXT.canvas_kits.guidelines,
	...TOOL_TEXT.canvas_screenshot.guidelines,
].join("\n");

// ---- host management ---------------------------------------------------------------------

interface HostInfo {
	port: number;
	token: string;
	pid: number;
}

function readHost(): HostInfo | undefined {
	try {
		const h = JSON.parse(readFileSync(serverFile(), "utf8"));
		return typeof h.port === "number" && typeof h.token === "string" ? h : undefined;
	} catch {
		return undefined;
	}
}

async function call(h: HostInfo, path: string, body: unknown, timeoutMs = 10_000): Promise<any> {
	const res = await fetch(`http://127.0.0.1:${h.port}/api/agent/${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-pi-canvas-token": h.token },
		body: JSON.stringify(body ?? {}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
	return json;
}

async function alive(h: HostInfo | undefined): Promise<boolean> {
	if (!h) return false;
	try {
		await call(h, "ping", {}, 2000);
		return true;
	} catch {
		return false;
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Return a running host, starting one (detached, shared by every Codex session) if needed. */
export async function ensureHost(): Promise<HostInfo> {
	let h = readHost();
	if (await alive(h)) return h!;
	mkdirSync(canvasDir(), { recursive: true });
	const lock = join(canvasDir(), "host.lock");
	let owner = false;
	try {
		closeSync(openSync(lock, "wx"));
		owner = true;
	} catch {
		// another session is starting it; a stale lock (crash) is taken over after 15s
		try {
			if (Date.now() - statSync(lock).mtimeMs > 15_000) {
				writeFileSync(lock, "");
				owner = true;
			}
		} catch {
			owner = true;
		}
	}
	try {
		if (owner) {
			const logFd = openSync(join(canvasDir(), "host.log"), "a");
			const child = spawn(process.execPath, [HOST], { detached: true, stdio: ["ignore", logFd, logFd], env: process.env, windowsHide: true });
			child.unref();
			closeSync(logFd);
		}
		for (let i = 0; i < 100; i++) {
			await sleep(150);
			h = readHost();
			if (await alive(h)) return h!;
		}
		throw new Error(`pi-canvas host did not start; see ${join(canvasDir(), "host.log")}`);
	} finally {
		if (owner) rmSync(lock, { force: true });
	}
}

// ---- MCP stdio ---------------------------------------------------------------------------

type Msg = { jsonrpc?: string; id?: number | string; method?: string; params?: any };
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const reply = (id: Msg["id"], result: unknown) => send({ jsonrpc: "2.0", id, result });
const fail = (id: Msg["id"], code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

let pinger: NodeJS.Timeout | undefined;
function keepHostAlive() {
	pinger ??= setInterval(async () => {
		const h = readHost();
		if (h) await call(h, "ping", {}, 2000).catch(() => {});
	}, 30_000);
	pinger.unref();
}

async function onCall(m: Msg) {
	const name = String(m.params?.name ?? "");
	if (!TOOLS.some((t) => t.name === name)) return fail(m.id, -32602, `unknown tool: ${name}`);
	const meta = m.params?._meta ?? {};
	const turn = meta["x-codex-turn-metadata"] ?? {};
	const threadId = meta.threadId ?? turn.thread_id ?? process.env.CODEX_THREAD_ID;
	const cwd = Object.keys(turn.workspaces ?? {})[0] ?? process.cwd();
	try {
		const h = await ensureHost();
		keepHostAlive();
		const r = await call(h, "tool", { name, args: m.params?.arguments ?? {}, threadId, cwd }, 180_000);
		// no structuredContent: Codex shows the model structuredContent instead of the text when both are present
		reply(m.id, { content: r.content ?? [], ...(r.isError ? { isError: true } : {}) });
	} catch (err) {
		reply(m.id, { content: [{ type: "text", text: `pi-canvas: ${(err as Error).message}` }], isError: true });
	}
}

function main() {
	createInterface({ input: process.stdin }).on("line", (line) => {
		let m: Msg;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		if (!m.method) return;
		switch (m.method) {
			case "initialize":
				return reply(m.id, {
					protocolVersion: m.params?.protocolVersion ?? "2025-06-18",
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "pi-canvas", title: "pi canvas", version: VERSION },
					instructions: INSTRUCTIONS,
				});
			case "tools/list":
				return reply(m.id, { tools: TOOLS });
			case "tools/call":
				return void onCall(m);
			case "ping":
				return reply(m.id, {});
			default:
				if (m.id !== undefined) {
					if (m.method.startsWith("notifications/")) return;
					if (/^(resources|prompts)\/list$/.test(m.method)) return reply(m.id, { [m.method.split("/")[0]]: [] });
					return fail(m.id, -32601, `method not found: ${m.method}`);
				}
		}
	});
	process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
export { main };
