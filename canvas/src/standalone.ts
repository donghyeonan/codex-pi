/**
 * Standalone pi-canvas host: the same browser workspace without pi.
 *
 * Any agent that can run shell commands (e.g. a Claude Code session) drives it:
 *   - browser chat messages are appended to <dir>/inbox.jsonl (watch it with `tail -f`)
 *   - the agent replies, reads and edits documents through /api/agent/* (see bin/canvas-agent.mjs)
 *
 * Run: node src/standalone.ts [--dir .pi/canvas] [--port 4519] [--agent-name "Claude"]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CanvasContext, outline, renderContext, truncate } from "./context.ts";
import type { UiMessage } from "./messages.ts";
import { CanvasServer } from "./server.ts";
import { type CanvasDoc, type CanvasOp, DocStore } from "./store.ts";

const args = process.argv.slice(2);
const arg = (name: string, def?: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
};
const DIR = resolve(arg("dir", join(process.cwd(), ".pi", "canvas"))!);
const PORT = Number(arg("port", process.env.PI_CANVAS_PORT ?? "4519"));
const AGENT = arg("agent-name", process.env.PI_CANVAS_AGENT_NAME ?? "Claude Code · cloud session")!;
const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "web");
mkdirSync(DIR, { recursive: true });

const INBOX = join(DIR, "inbox.jsonl");
const CHAT = join(DIR, "chat.json");
const ATTACH = join(DIR, "attachments");
const token = randomBytes(16).toString("hex");
const store = new DocStore(DIR);
let busy = false;
let activeDocId: string | undefined = store.latest()?.id;
let messages: UiMessage[] = existsSync(CHAT) ? JSON.parse(readFileSync(CHAT, "utf8")) : [];
let seq = Date.now();
const nextTs = () => (seq = Math.max(seq + 1, Date.now()));

const saveChat = () => writeFileSync(CHAT, JSON.stringify(messages.slice(-500), null, 1));

let server: CanvasServer;
const broadcast = (e: unknown) => server?.broadcast(e);

function pushMessage(m: UiMessage) {
	messages.push(m);
	saveChat();
	broadcast({ type: "message", phase: "end", message: m });
}

function setBusy(b: boolean) {
	busy = b;
	broadcast({ type: "busy", busy });
}

function applyOps(docId: string, ops: CanvasOp[], origin: "agent" | "browser") {
	const res = store.apply(docId, ops);
	const changed = ops.map((o) => ("id" in o && o.id ? o.id : undefined)).filter(Boolean).concat(res.added);
	broadcast({ type: "doc", origin, doc: res.doc, changed });
	broadcast({ type: "docs", docs: store.list() });
	return res;
}

function resolveDoc(docId?: string): CanvasDoc {
	const doc = docId ? store.get(docId) : (activeDocId && store.get(activeDocId)) || store.latest();
	if (!doc) throw new Error(docId ? `unknown docId ${docId}` : "no documents yet — create one with `report` or `new`");
	return doc;
}

function readView(doc: CanvasDoc, full: boolean) {
	return {
		id: doc.id,
		title: doc.title,
		version: doc.version,
		report: { chars: doc.reportHtml.length, outline: outline(doc.reportHtml), ...(full ? { html: doc.reportHtml } : {}) },
		variables: doc.variables ?? {},
		comments: (doc.comments ?? []).filter((c) => !c.resolved),
		slideOrder: doc.slideOrder,
		nodes: doc.nodes.map((n) => ({ ...n, html: full ? n.html : truncate(n.html, 300), d: full ? n.d : truncate(n.d, 200) })),
	};
}

let toolSeq = 0;
function toolCard(name: string, args: unknown, resultText: string, isError = false) {
	const id = `call_${Date.now().toString(36)}_${toolSeq++}`;
	const ts = nextTs();
	pushMessage({ key: `assistant:${ts}`, role: "assistant", text: "", tools: [{ id, name, args }], ts });
	pushMessage({ key: `toolResult:${id}`, role: "toolResult", text: resultText, toolCallId: id, toolName: name, isError, ts: nextTs() });
}

server = new CanvasServer(WEB, token, {
	snapshot: () => ({
		session: { id: "cloud-session", name: AGENT, cwd: process.cwd() },
		model: { id: "agent", name: AGENT },
		busy,
		messages,
		docs: store.list(),
		activeDocId,
	}),
	listDocs: () => store.list(),
	getDoc: (id) => store.get(id),
	createDoc: (title, html) => {
		const doc = store.create(title, html);
		activeDocId = doc.id;
		broadcast({ type: "docs", docs: store.list() });
		return doc;
	},
	applyOps: (id, ops) => applyOps(id, ops as CanvasOp[], "browser"),
	prompt: ({ text, context, images }) => {
		const trimmed = text.trim();
		if (!trimmed && !images?.length) return { ok: false, error: "empty message" };
		const c = context as CanvasContext | undefined;
		if (c?.docId && store.get(c.docId)) activeDocId = c.docId;
		const full = trimmed + renderContext(c);
		const ts = nextTs();
		const files: string[] = [];
		for (const [i, img] of (images ?? []).entries()) {
			mkdirSync(ATTACH, { recursive: true });
			const f = join(ATTACH, `${ts}-${i}.${img.mimeType.split("/")[1] ?? "png"}`);
			writeFileSync(f, Buffer.from(img.data, "base64"));
			files.push(f);
		}
		pushMessage({ key: `user:${ts}`, role: "user", text: full, images: files.length || undefined, ts });
		appendFileSync(INBOX, `${JSON.stringify({ id: ts, text: trimmed, context: c, docId: activeDocId, images: files })}\n`);
		const wasBusy = busy;
		setBusy(true);
		return { ok: true, queued: wasBusy };
	},
	abort: () => {
		appendFileSync(INBOX, `${JSON.stringify({ id: nextTs(), type: "abort" })}\n`);
		setBusy(false);
	},
	skills: () => [],
	importUrl: async (raw) => {
		const url = new URL(raw);
		if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs can be imported");
		const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
		let html = (await res.text()).slice(0, 3_000_000);
		const base = `<base href="${res.url.replace(/"/g, "&quot;")}">`;
		html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`;
		const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url.hostname;
		return { html, title, url: res.url };
	},
	agentApi: (path, method, body, url) => {
		switch (`${method} ${path}`) {
			case "POST say": {
				const ts = nextTs();
				pushMessage({ key: `assistant:${ts}`, role: "assistant", text: String(body.text ?? ""), ts });
				if (body.done !== false) setBusy(false);
				return { ok: true };
			}
			case "POST busy":
				setBusy(Boolean(body.busy));
				return { ok: true };
			case "GET read": {
				const doc = resolveDoc(url.searchParams.get("docId") ?? undefined);
				return readView(doc, url.searchParams.get("full") === "1");
			}
			case "POST ops": {
				const doc = resolveDoc(body.docId);
				const ops = Array.isArray(body.ops) ? body.ops : [];
				try {
					const res = applyOps(doc.id, ops, "agent");
					if (body.card !== false) toolCard("canvas_edit", { ops }, `${res.results.join("\n")}\nversion ${res.doc.version}`);
					return { docId: doc.id, version: res.doc.version, results: res.results, added: res.added };
				} catch (err) {
					if (body.card !== false) toolCard("canvas_edit", { ops }, String((err as Error).message), true);
					throw err;
				}
			}
			case "POST report": {
				const html = String(body.html ?? "");
				let doc: CanvasDoc;
				if (body.docId && store.get(body.docId)) {
					doc = applyOps(body.docId, [{ op: "set_report", html }, { op: "set_title", title: String(body.title ?? "Report") }], "agent").doc;
				} else {
					doc = store.create(String(body.title ?? "Untitled"), html);
					broadcast({ type: "docs", docs: store.list() });
				}
				activeDocId = doc.id;
				broadcast({ type: "navigate", docId: doc.id, view: body.view ?? (html.replace(/<[^>]+>/g, "").trim() ? "report" : "canvas") });
				if (body.card !== false) toolCard("canvas_report", { title: doc.title }, `Opened "${doc.title}" (docId ${doc.id}, version ${doc.version})`);
				return { docId: doc.id, version: doc.version };
			}
			case "POST navigate":
				if (body.docId) activeDocId = body.docId;
				broadcast({ type: "navigate", docId: body.docId, view: body.view });
				return { ok: true };
			case "GET inbox": {
				const after = Number(url.searchParams.get("after") ?? 0);
				if (!existsSync(INBOX)) return [];
				return readFileSync(INBOX, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id > after);
			}
			default:
				throw new Error(`unknown agent endpoint ${method} ${path}`);
		}
	},
});

const port = await server.start(PORT);
writeFileSync(join(DIR, "server.json"), JSON.stringify({ port, token, pid: process.pid }, null, 2));
if (!existsSync(INBOX)) writeFileSync(INBOX, "");
console.log(`pi-canvas standalone on http://127.0.0.1:${port}/?t=${token}`);
console.log(`inbox: ${INBOX}`);
// keep the process alive (server.unref() is used for the pi extension)
setInterval(() => {}, 1 << 30);
