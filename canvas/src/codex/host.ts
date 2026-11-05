/**
 * pi-canvas host for the Codex CLI.
 *
 * One long-lived process per CODEX_HOME serves the browser workspace (default http://127.0.0.1:3000) and
 * keeps the documents. Codex reaches it through the pi-canvas MCP server (src/codex/mcp.ts), which forwards
 * tool calls here together with the calling session's thread id; the host then joins that thread on the
 * Codex app-server daemon (src/codex/bridge.ts) so the canvas chat is the terminal session itself.
 *
 * Run: node src/codex/host.ts            (normally started on demand by the MCP server)
 * Env: CODEX_HOME, PI_CANVAS_PORT (default 3000), PI_CANVAS_NO_OPEN, PI_CANVAS_IDLE_MINUTES (default 30)
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CanvasContext, renderContext } from "../context.ts";
import { canvasEdit, canvasNew, canvasRead, canvasReport, canvasScreenshot, type CoreHost, importUrl, openBrowser, type ToolResult } from "../core.ts";
import type { UiMessage } from "../messages.ts";
import { CanvasServer } from "../server.ts";
import { type CanvasOp, DocStore } from "../store.ts";
import { CodexBridge } from "./bridge.ts";
import { canvasDir, DEFAULT_PORT, serverFile } from "./paths.ts";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const DIR = canvasDir();
const ATTACH = join(DIR, "attachments");
const IDLE_MS = (Number(process.env.PI_CANVAS_IDLE_MINUTES) || 30) * 60_000;
mkdirSync(DIR, { recursive: true });

const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

// keep the token across restarts so open tabs keep working
let token = randomBytes(16).toString("hex");
try {
	const prev = JSON.parse(readFileSync(serverFile(), "utf8"));
	if (typeof prev.token === "string" && /^[0-9a-f]{32}$/.test(prev.token)) token = prev.token;
} catch {}

const store = new DocStore(DIR);
let activeDocId: string | undefined = store.latest()?.id;
let lastPing = Date.now();
let seq = Date.now();
const nextTs = () => (seq = Math.max(seq + 1, Date.now()));
/** browser messages that could not reach Codex live; handed to the agent with its next canvas tool result */
let offlineInbox: { ts: number; text: string }[] = [];
const localNotes: UiMessage[] = [];

let server: CanvasServer;
const broadcast = (e: unknown) => server?.broadcast(e);

const bridge = new CodexBridge({
	emit: (e: any) => {
		if (e?.type === "snapshot-changed") broadcast({ type: "snapshot", ...snapshot() });
		else broadcast(e);
	},
	log,
});

function snapshot() {
	const t = bridge.thread;
	return {
		session: { id: t?.id ?? "codex", name: bridge.sessionName(), cwd: t?.cwd, agent: "codex", live: bridge.live },
		model: t?.model ? { id: t.model, name: t.model, provider: t.provider } : { id: "codex", name: "Codex" },
		busy: bridge.busy,
		messages: [...bridge.messages, ...localNotes].sort((a, b) => a.ts - b.ts),
		docs: store.list(),
		activeDocId,
	};
}

function note(text: string) {
	const m: UiMessage = { key: `custom:${nextTs()}`, role: "custom", customType: "pi-canvas", text, ts: nextTs() };
	localNotes.push(m);
	broadcast({ type: "message", phase: "end", message: m });
}

function applyOps(docId: string, ops: CanvasOp[], origin: "agent" | "browser") {
	const res = store.apply(docId, ops);
	const changed = ops.map((o) => ("id" in o && o.id ? o.id : undefined)).filter(Boolean).concat(res.added);
	broadcast({ type: "doc", origin, doc: res.doc, changed });
	broadcast({ type: "docs", docs: store.list() });
	return res;
}

async function show(docId: string | undefined, view?: "report" | "canvas") {
	if (docId) activeDocId = docId;
	const url = server.url(docId, view);
	if (server.clientCount > 0) broadcast({ type: "navigate", docId, view });
	else openBrowser(url);
	return url;
}

let toolCwd = process.cwd();
const host: CoreHost = {
	store: () => store,
	cwd: () => toolCwd,
	getActive: () => activeDocId,
	setActive: (id) => {
		activeDocId = id;
	},
	applyOps,
	broadcast,
	show,
	hasServer: () => server.clientCount > 0,
	captureUrl: async (docId, nodeId) => server.captureUrl(docId, nodeId),
};

const BROWSER_NOTE =
	"The user can switch Report/Canvas views and chat with you from the browser: that chat is this Codex session, so their messages arrive here as user turns with a <canvas_context> block.";

async function runTool(name: string, args: any): Promise<ToolResult> {
	switch (name) {
		case "canvas_open": {
			const doc = args?.docId ? store.get(args.docId) : undefined;
			if (args?.docId && !doc) throw new Error(`unknown docId: ${args.docId}`);
			const target = doc?.id ?? activeDocId ?? store.latest()?.id;
			const url = await show(target, args?.view);
			const docs = store.list() as { id: string; title: string }[];
			return {
				content: [
					{
						type: "text",
						text: `pi-canvas is open at ${url}\n${target ? `Showing document ${target}.` : "No documents yet: create one with canvas_report (HTML report) or canvas_new (design)."}${docs.length ? `\nDocuments: ${docs.slice(0, 20).map((d) => `${d.id} "${d.title}"`).join(", ")}` : ""}\nThe chat panel there is this Codex session (messages typed in the browser arrive here as your next user turn).`,
					},
				],
				details: { url, docId: target },
			};
		}
		case "canvas_report":
			return canvasReport(host, args ?? {}, BROWSER_NOTE);
		case "canvas_read":
			return canvasRead(host, args ?? {});
		case "canvas_edit":
			return canvasEdit(host, args ?? {});
		case "canvas_new":
			return canvasNew(host, args ?? {});
		case "canvas_screenshot":
			return canvasScreenshot(host, args ?? {});
	}
	throw new Error(`unknown tool ${name}`);
}

server = new CanvasServer(WEB, token, {
	snapshot,
	listDocs: () => store.list(),
	getDoc: (id) => store.get(id),
	createDoc: (title, html) => {
		const doc = store.create(title, html);
		activeDocId = doc.id;
		broadcast({ type: "docs", docs: store.list() });
		return doc;
	},
	applyOps: (id, ops) => applyOps(id, ops as CanvasOp[], "browser"),
	prompt: async ({ text, context, images }) => {
		const trimmed = text.trim();
		if (!trimmed && !images?.length) return { ok: false, error: "empty message" };
		const c = context as CanvasContext | undefined;
		if (c?.docId && store.get(c.docId)) activeDocId = c.docId;
		const full = trimmed + renderContext(c);
		const input: Record<string, unknown>[] = [{ type: "text", text: full || "(see attached image)", text_elements: [] }];
		for (const [i, img] of (images ?? []).entries()) {
			mkdirSync(ATTACH, { recursive: true });
			const f = join(ATTACH, `${nextTs()}-${i}.${img.mimeType.split("/")[1] ?? "png"}`);
			writeFileSync(f, Buffer.from(img.data, "base64"));
			input.push({ type: "localImage", path: f });
		}
		const r = await bridge.prompt(input);
		if (r.ok || !bridge.thread) return r;
		// session not reachable live: keep the message for the agent's next canvas tool call
		offlineInbox.push({ ts: nextTs(), text: full });
		const m: UiMessage = { key: `user:${nextTs()}`, role: "user", text: full, images: images?.length || undefined, ts: nextTs() };
		localNotes.push(m);
		broadcast({ type: "message", phase: "end", message: m });
		note(`Codex isn't reachable live (${r.error}). The message is queued and Codex will see it on its next canvas tool call.`);
		return { ok: true, queued: true };
	},
	abort: () => bridge.interrupt(),
	skills: () => [],
	importUrl,
	agentApi: async (path, method, body) => {
		switch (`${method} ${path}`) {
			case "POST ping":
				lastPing = Date.now();
				return { ok: true, pid: process.pid, port: server.port, thread: bridge.thread?.id, live: bridge.live };
			case "POST stop":
				setTimeout(() => shutdown("stop requested"), 50);
				return { ok: true };
			case "POST attach": {
				const ok = body.threadId ? await bridge.attach(String(body.threadId), { cwd: body.cwd }) : false;
				return { ok, live: bridge.live };
			}
			case "POST tool": {
				lastPing = Date.now();
				if (typeof body.cwd === "string" && existsSync(body.cwd)) toolCwd = body.cwd;
				// join the calling session in the background: thread/resume must never hold up the tool call
				if (body.threadId && (bridge.thread?.id !== body.threadId || !bridge.live)) {
					void bridge.attach(String(body.threadId), { cwd: body.cwd }).then((ok) => log(`attached to thread ${body.threadId}: ${ok ? "live" : "offline"}`));
				}
				let result: ToolResult;
				try {
					result = await runTool(String(body.name), body.args ?? {});
				} catch (err) {
					return { isError: true, content: [{ type: "text", text: String((err as Error).message ?? err) }] };
				}
				if (offlineInbox.length) {
					const msgs = offlineInbox.map((m) => `- ${m.text}`).join("\n");
					offlineInbox = [];
					result.content.push({ type: "text", text: `\nMessages the user sent from the pi-canvas chat while it could not reach this session live:\n${msgs}` });
				}
				return { content: result.content, details: result.details };
			}
			default:
				throw new Error(`unknown agent endpoint ${method} ${path}`);
		}
	},
});

function shutdown(why: string) {
	log(`shutting down: ${why}`);
	try {
		const cur = JSON.parse(readFileSync(serverFile(), "utf8"));
		if (cur.pid === process.pid) rmSync(serverFile());
	} catch {}
	bridge.close();
	void server.stop().finally(() => process.exit(0));
}

const preferred = Number(process.env.PI_CANVAS_PORT) || DEFAULT_PORT;
const port = await server.start(preferred);
writeFileSync(serverFile(), JSON.stringify({ port, token, pid: process.pid, url: `http://127.0.0.1:${port}/?t=${token}` }, null, 2));
log(`pi-canvas for Codex on http://127.0.0.1:${port}/?t=${token} (docs in ${DIR})`);
if (port !== preferred) log(`port ${preferred} was busy; using ${port}`);

// stay up while a Codex session (MCP ping) or a browser tab is around
setInterval(() => {
	if (server.clientCount === 0 && Date.now() - lastPing > IDLE_MS) shutdown("idle");
}, 30_000);
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// first connection attempt (cheap; failures are fine — the daemon may start later)
bridge
	.connect()
	.then(() => (bridge.thread ? true : bridge.attachLatest()))
	.then((ok) => ok && log(`attached to the latest Codex session ${bridge.thread?.id}`))
	.catch((err) => log(`codex daemon not reachable yet: ${(err as Error).message}`));
