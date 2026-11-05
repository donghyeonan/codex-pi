/**
 * pi-canvas — open reports in a browser workspace with:
 *   - a Report view (the HTML as-is),
 *   - a Canvas view (pen-style infinite canvas; report sections become frames),
 *   - a chat panel that IS the running Pi session (same transcript, same context).
 *
 * Messages typed in the browser are injected with pi.sendUserMessage() so they show up in the
 * terminal and land in the session file; everything the agent streams is forwarded to the browser
 * over Server-Sent Events. Nothing runs a second agent.
 */
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { branchToUi, toUiMessage } from "./messages.ts";
import { type CanvasContext, renderContext } from "./context.ts";
import { canvasEdit, canvasKits, canvasNew, canvasRead, canvasReport, canvasScreenshot, type CoreHost, importUrl, NODE_DOC, openBrowser, OP_NAMES, resolveDoc, TOOL_TEXT } from "./core.ts";
import { CanvasServer } from "./server.ts";
import { type CanvasOp, DocStore } from "./store.ts";
import { kitApi } from "./kits.ts";

const HERE = (() => {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return typeof __dirname === "string" ? __dirname : process.cwd();
	}
})();
const WEB_DIR = resolve(HERE, "..", "web");
const DEFAULT_PORT = Number(process.env.PI_CANVAS_PORT) || 4519;

/** Survives /reload, /new and /resume (the extension module is re-instantiated, the process is not). */
interface ProcessState {
	token: string;
	port?: number;
	running: boolean;
	activeDocId?: string;
}
const G = globalThis as typeof globalThis & { __piCanvas?: ProcessState };
const proc: ProcessState = (G.__piCanvas ??= { token: randomBytes(16).toString("hex"), running: false });


const OpSchema = Type.Object({
	op: StringEnum(OP_NAMES, { description: "Operation" }),
	id: Type.Optional(Type.String({ description: "Node or comment id (update, delete, replace_in_node, update_comment, delete_comment)" })),
	node: Type.Optional(
		Type.Record(Type.String(), Type.Any(), { description: NODE_DOC }),
	),
	props: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "update / update_comment: fields to change (null removes a field)" })),
	html: Type.Optional(Type.String({ description: "set_report: full new report HTML" })),
	htmlPath: Type.Optional(Type.String({ description: "set_report: read the new report HTML from this file instead" })),
	find: Type.Optional(Type.String({ description: "replace_*: exact text to find" })),
	replace: Type.Optional(Type.String({ description: "replace_*: replacement text" })),
	all: Type.Optional(Type.Boolean({ description: "replace_*: replace every occurrence (default first only)" })),
	title: Type.Optional(Type.String({ description: "set_title: new document title" })),
	variables: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "set_variables: name -> value (e.g. primary -> #4f46e5); use as \"$primary\" in colors" })),
	comment: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "add_comment: {text, x, y, nodeId?}" })),
	ids: Type.Optional(Type.Array(Type.String(), { description: "set_slide_order: top-level frame ids in presentation order" })),
});

export default function piCanvas(pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | undefined;
	let store: DocStore | undefined;
	let server: CanvasServer | undefined;
	let starting: Promise<CanvasServer> | undefined;
	let busy = false;

	const getStore = (ctx?: ExtensionContext) => {
		if (!store) {
			const cwd = ctx?.cwd ?? ctxRef?.cwd ?? process.cwd();
			store = new DocStore(join(cwd, CONFIG_DIR_NAME ?? ".pi", "canvas"));
		}
		return store;
	};

	const snapshot = () => {
		const ctx = ctxRef;
		const sm = ctx?.sessionManager;
		let messages: unknown[] = [];
		try {
			messages = sm ? branchToUi(sm.getBranch() as any[]) : [];
		} catch {
			messages = [];
		}
		return {
			session: sm
				? { id: sm.getSessionId(), name: sm.getSessionName?.(), file: sm.getSessionFile(), cwd: sm.getCwd() }
				: undefined,
			model: ctx?.model ? { id: ctx.model.id, provider: ctx.model.provider, name: ctx.model.name } : undefined,
			busy,
			messages,
			docs: getStore().list(),
			activeDocId: proc.activeDocId,
		};
	};

	const broadcast = (event: unknown) => server?.broadcast(event);

	const applyOps = (docId: string, ops: CanvasOp[], origin: "agent" | "browser") => {
		const res = getStore().apply(docId, ops);
		const changed = ops
			.map((o) => ("id" in o && o.id ? o.id : undefined))
			.filter(Boolean)
			.concat(res.added);
		broadcast({ type: "doc", origin, doc: res.doc, changed });
		broadcast({ type: "docs", docs: getStore().list() });
		return res;
	};

	const updateStatus = () => {
		const ctx = ctxRef;
		if (!ctx?.hasUI) return;
		try {
			ctx.ui.setStatus("pi-canvas", server ? `canvas ${server.url().replace(/\?t=.*/, "")}` : undefined);
		} catch {
			// UI not available in this mode
		}
	};

	const ensureServer = async (): Promise<CanvasServer> => {
		if (server) return server;
		if (starting) return starting;
		starting = (async () => {
			const s = new CanvasServer(WEB_DIR, proc.token, {
				snapshot,
				listDocs: () => getStore().list(),
				getDoc: (id) => getStore().get(id),
				createDoc: (title, html) => {
					const doc = getStore().create(title, html);
					proc.activeDocId = doc.id;
					broadcast({ type: "docs", docs: getStore().list() });
					return doc;
				},
				applyOps: (id, ops) => applyOps(id, ops as CanvasOp[], "browser"),
				agentApi: (path, method, body) => kitApi(path, method, body, (id) => resolveDoc(host, id), (id, ops) => applyOps(id, ops, "browser")),
				prompt: ({ text, context, images }) => {
					const trimmed = text.trim();
					if (!trimmed && !images?.length) return { ok: false, error: "empty message" };
					const c = context as CanvasContext | undefined;
					if (c?.docId && getStore().get(c.docId)) proc.activeDocId = c.docId;
					const slash = trimmed.startsWith("/");
					const full = slash ? trimmed : trimmed + renderContext(c);
					const content = images?.length
						? [{ type: "text" as const, text: full || "(see attached image)" }, ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }))]
						: full;
					const idle = ctxRef?.isIdle() ?? true;
					try {
						const opts = { ...(idle ? {} : { deliverAs: "steer" as const }), ...(slash ? { expandPromptTemplates: true } : {}) };
						pi.sendUserMessage(content, opts);
					} catch (err) {
						return { ok: false, error: String((err as Error).message ?? err) };
					}
					return { ok: true, queued: !idle };
				},
				abort: () => ctxRef?.abort(),
				skills: () => {
					try {
						return pi.getCommands().map((c) => ({ name: c.name, description: c.description, source: c.source }));
					} catch {
						return [];
					}
				},
				importUrl,
			});
			const port = await s.start(proc.port ?? DEFAULT_PORT);
			proc.port = port;
			proc.running = true;
			server = s;
			updateStatus();
			return s;
		})();
		try {
			return await starting;
		} finally {
			starting = undefined;
		}
	};

	const show = async (docId: string | undefined, view?: "report" | "canvas") => {
		const s = await ensureServer();
		if (docId) proc.activeDocId = docId;
		const url = s.url(docId, view);
		if (s.clientCount > 0) broadcast({ type: "navigate", docId, view });
		else openBrowser(url);
		return url;
	};

	const host: CoreHost = {
		store: () => getStore(),
		cwd: () => ctxRef?.cwd ?? process.cwd(),
		getActive: () => proc.activeDocId,
		setActive: (id) => {
			proc.activeDocId = id;
		},
		applyOps,
		broadcast,
		show,
		hasServer: () => Boolean(server),
		captureUrl: async (docId, nodeId) => (await ensureServer()).captureUrl(docId, nodeId),
	};

	// ---- lifecycle -------------------------------------------------------------------------

	const track = (_e: unknown, ctx: ExtensionContext) => {
		ctxRef = ctx;
	};

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		// Keep the browser connected across /reload, /new, /resume: restart on the same port.
		if (proc.running) {
			try {
				await ensureServer();
			} catch {
				proc.running = false;
			}
		}
	});

	pi.on("session_shutdown", async (event) => {
		const s = server;
		server = undefined;
		if (s) {
			s.broadcast({ type: "session_ending", reason: event.reason });
			await s.stop();
		}
		// quitting stops for good; replacements restart in the next runtime
		if (event.reason === "quit") proc.running = false;
	});

	// ---- forward the live session to the browser --------------------------------------------

	const pending = new Map<string, unknown>();
	let flushTimer: NodeJS.Timeout | undefined;
	const flush = () => {
		flushTimer = undefined;
		for (const message of pending.values()) broadcast({ type: "message", phase: "update", message });
		pending.clear();
	};

	pi.on("message_start", (event, ctx) => {
		track(event, ctx);
		if (!server) return;
		const m = toUiMessage(event.message as any);
		if (m) broadcast({ type: "message", phase: "start", message: m });
	});

	pi.on("message_update", (event, ctx) => {
		track(event, ctx);
		if (!server) return;
		const m = toUiMessage(event.message as any);
		if (!m) return;
		pending.set(m.key, m);
		flushTimer ??= setTimeout(flush, 50);
	});

	pi.on("message_end", (event, ctx) => {
		track(event, ctx);
		if (!server) return;
		const m = toUiMessage(event.message as any);
		if (!m) return;
		pending.delete(m.key);
		broadcast({ type: "message", phase: "end", message: m });
	});

	pi.on("tool_execution_start", (event, ctx) => {
		track(event, ctx);
		broadcast({ type: "tool", phase: "start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
	});

	pi.on("tool_execution_end", (event, ctx) => {
		track(event, ctx);
		broadcast({ type: "tool", phase: "end", toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
	});

	pi.on("agent_start", (event, ctx) => {
		track(event, ctx);
		busy = true;
		broadcast({ type: "busy", busy });
	});

	pi.on("agent_settled", (event, ctx) => {
		track(event, ctx);
		busy = false;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flush();
		}
		broadcast({ type: "busy", busy });
	});

	pi.on("model_select", (event, ctx) => {
		track(event, ctx);
		const m = (event as any).model ?? ctx.model;
		if (m) broadcast({ type: "model", model: { id: m.id, provider: m.provider, name: m.name } });
	});

	pi.on("session_info_changed", (event, ctx) => {
		track(event, ctx);
		broadcast({ type: "session", name: (event as any).name });
	});

	// ---- tools ------------------------------------------------------------------------------

	pi.registerTool({
		name: "canvas_report",
		label: "Canvas Report",
		description: TOOL_TEXT.canvas_report.description,
		promptSnippet: TOOL_TEXT.canvas_report.snippet,
		promptGuidelines: [...TOOL_TEXT.canvas_report.guidelines],
		parameters: Type.Object({
			title: Type.String({ description: "Document title" }),
			html: Type.Optional(Type.String({ description: "Complete HTML document" })),
			path: Type.Optional(Type.String({ description: "Path to an existing HTML file (relative to cwd)" })),
			docId: Type.Optional(Type.String({ description: "Existing document to replace the report of" })),
			view: Type.Optional(StringEnum(["report", "canvas"] as const, { description: "Initial view (default report)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			getStore(ctx);
			return canvasReport(host, params as any);
		},
	});

	pi.registerTool({
		name: "canvas_kits",
		label: "Canvas Kits",
		description: TOOL_TEXT.canvas_kits.description,
		promptSnippet: TOOL_TEXT.canvas_kits.snippet,
		promptGuidelines: [...TOOL_TEXT.canvas_kits.guidelines],
		parameters: Type.Object({
			kit: Type.Optional(Type.String()),
			component: Type.Optional(Type.String({ description: "Exact component name or kit id to inspect" })),
			insert: Type.Optional(Type.Union([Type.Literal("all"), Type.Array(Type.String())])),
			docId: Type.Optional(Type.String()),
			x: Type.Optional(Type.Number()),
			y: Type.Optional(Type.Number()),
			theme: Type.Optional(Type.String({ description: "Light (default) or Dark, case insensitive" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			return canvasKits(host, params);
		},
	});

	pi.registerTool({
		name: "canvas_read",
		label: "Canvas Read",
		description: TOOL_TEXT.canvas_read.description,
		promptSnippet: TOOL_TEXT.canvas_read.snippet,
		parameters: Type.Object({
			docId: Type.Optional(Type.String({ description: "Document id (default: active document)" })),
			full: Type.Optional(Type.Boolean({ description: "Include full HTML (default false)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			return canvasRead(host, params);
		},
	});

	pi.registerTool({
		name: "canvas_edit",
		label: "Canvas Edit",
		description: TOOL_TEXT.canvas_edit.description,
		promptSnippet: TOOL_TEXT.canvas_edit.snippet,
		parameters: Type.Object({
			docId: Type.Optional(Type.String({ description: "Document id (default: active document)" })),
			ops: Type.Array(OpSchema, { description: "Operations, applied in order" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			return canvasEdit(host, params as { docId?: string; ops: CanvasOp[] });
		},
	});

	pi.registerTool({
		name: "canvas_new",
		label: "Canvas New",
		description: TOOL_TEXT.canvas_new.description,
		promptSnippet: TOOL_TEXT.canvas_new.snippet,
		promptGuidelines: [...TOOL_TEXT.canvas_new.guidelines],
		parameters: Type.Object({
			title: Type.String({ description: "Document title" }),
			frames: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.Optional(Type.String({ description: "Frame name" })),
						w: Type.Optional(Type.Number({ description: "Width (overrides the preset)" })),
						h: Type.Optional(Type.Number({ description: "Height (overrides the preset)" })),
						preset: Type.Optional(StringEnum(["desktop", "tablet", "mobile"] as const, { description: "desktop 1440x1024 (default), tablet 834x1194, mobile 390x844" })),
					}),
					{ description: "Empty frames to create, left to right" },
				),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ctxRef = ctx;
			getStore(ctx);
			return canvasNew(host, params as any);
		},
	});

	pi.registerTool({
		name: "canvas_screenshot",
		label: "Canvas Screenshot",
		description: TOOL_TEXT.canvas_screenshot.description,
		promptSnippet: TOOL_TEXT.canvas_screenshot.snippet,
		promptGuidelines: [...TOOL_TEXT.canvas_screenshot.guidelines],
		parameters: Type.Object({
			docId: Type.Optional(Type.String({ description: "Document id (default: active document)" })),
			nodeId: Type.Optional(Type.String({ description: "Frame or layer id (default: the whole document)" })),
			scale: Type.Optional(Type.Number({ description: "Pixel scale, 1 or 2 (default 1)", minimum: 1, maximum: 2 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			ctxRef = ctx;
			getStore(ctx);
			return canvasScreenshot(host, params, signal);
		},
	});

	// ---- commands ---------------------------------------------------------------------------

	pi.registerCommand("canvas", {
		description: "Open the pi-canvas browser workspace (/canvas [docId] | /canvas url | /canvas stop)",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const arg = (args ?? "").trim();
			if (arg === "stop") {
				const s = server;
				server = undefined;
				proc.running = false;
				await s?.stop();
				updateStatus();
				ctx.ui.notify("pi-canvas stopped", "info");
				return;
			}
			const s = await ensureServer();
			const doc = arg && arg !== "url" ? getStore(ctx).get(arg) : undefined;
			if (arg && arg !== "url" && !doc) {
				ctx.ui.notify(`pi-canvas: unknown document ${arg}`, "warning");
				return;
			}
			const target = doc?.id ?? proc.activeDocId ?? getStore(ctx).latest()?.id;
			if (arg === "url") {
				ctx.ui.notify(s.url(target), "info");
				return;
			}
			const url = await show(target);
			ctx.ui.notify(`pi-canvas: ${url}`, "info");
		},
	});
}
