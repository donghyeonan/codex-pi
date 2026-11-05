/**
 * Tool logic shared by every host (the pi extension, the Codex host): what canvas_report, canvas_read,
 * canvas_edit, canvas_new and canvas_screenshot do, independent of how the host registers tools.
 * Kept free of pi and Codex imports.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { outline, truncate } from "./context.ts";
import { captureScreenshot, findChrome, MAX_SIDE, targetRect } from "./screenshot.ts";
import type { CanvasDoc, CanvasOp, DocStore } from "./store.ts";

export const PRESETS = { desktop: [1440, 1024], tablet: [834, 1194], mobile: [390, 844] } as const;
const FRAME_GAP = 80;

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
	content: ToolContent[];
	details: Record<string, unknown>;
}

export interface CoreHost {
	store(): DocStore;
	/** cwd for relative paths */
	cwd(): string;
	getActive(): string | undefined;
	setActive(id: string): void;
	applyOps(docId: string, ops: CanvasOp[], origin: "agent" | "browser"): ReturnType<DocStore["apply"]>;
	broadcast(event: unknown): void;
	/** Show a document in the browser (navigate open tabs, or open a new one); returns its URL. */
	show(docId: string | undefined, view?: "report" | "canvas"): Promise<string>;
	/** True when a browser is attached (canvas_edit opens one otherwise). */
	hasServer(): boolean;
	captureUrl(docId: string, nodeId?: string): Promise<string>;
}

export const TOOL_TEXT = {
	canvas_report: {
		description:
			"Show an HTML report in the pi-canvas browser workspace (Report view + design Canvas view + a chat that is this same session). Creates a new document, or replaces the report of an existing one when docId is given. Provide either html (a complete self-contained HTML document) or path (an existing .html file).",
		snippet: "Open an HTML report in the pi-canvas browser workspace (report + design canvas + shared chat)",
		guidelines: [
			"When the user asks for a report, document, dashboard, one-pager, summary page or other visual deliverable, write a complete self-contained HTML document (inline CSS; CDN scripts are allowed) and show it with canvas_report.",
			"Structure canvas_report HTML with one <section> per logical part (each with an <h2>), because the Canvas view turns each top-level <section> into its own frame.",
			"When a user message ends with a <canvas_context> block it was sent from the pi-canvas browser; call canvas_read for that doc first, then apply changes with canvas_edit (do not rewrite the file with write/edit tools).",
			"Use canvas_edit replace_in_report for small report changes, set_report for rewrites, and add/update/delete for canvas layers.",
			"pi-canvas layers form a tree: x/y are relative to parentId (a frame or group). Build designs as frames containing text, rect, ellipse, icon and image layers (use frame layout for flex stacks), or as a frame with html for rich HTML content.",
			"Respect each selected layer's context notes in <canvas_context>; unresolved canvas comments are feedback from the user (canvas_read lists them).",
		],
	},
	canvas_read: {
		description:
			"Read a pi-canvas document: title, version, report outline, and every canvas node (position, size, content). Defaults to the active document. Set full=true to include the complete report HTML and untruncated node HTML.",
		snippet: "Read the current state of a pi-canvas document (report + canvas nodes)",
	},
	canvas_edit: {
		description:
			"Edit a pi-canvas document with a list of operations applied atomically (all or nothing). The browser updates live. Ops: add {node}, update {id, props}, delete {id} (removes children too), set_report {html}, replace_in_report {find, replace, all?}, replace_in_node {id, find, replace, all?}, set_title {title}, clear_nodes, set_variables {variables}, add_comment {comment}, update_comment {id, props}, delete_comment {id}, set_slide_order {ids}. Layers form a tree: x/y are relative to parentId (a frame or group). Give new layers an explicit id in node.id when later ops in the same call refer to them.",
		snippet: "Edit a pi-canvas document: add/update/delete canvas nodes or patch the report HTML",
	},
	canvas_new: {
		description:
			"Start a new pi-canvas design document with no report and open it in the Canvas view. Optional frames are laid out left to right, 80px apart (presets: desktop 1440x1024, tablet 834x1194, mobile 390x844; w/h override). Returns the docId and frame ids; then build the design inside the frames with canvas_edit (parentId = frame id).",
		snippet: "Start a new pi-canvas design document (device-sized frames, no report)",
		guidelines: [
			"When the user asks for a screen, app or web page design rather than a report, start it with canvas_new (device preset frames) and build the layers with canvas_edit.",
			"Before designing on the canvas, read the bundled design skills that fit the work (better-layout, better-typography, better-colors, better-ui; better-writing for copy); use better-interface for a holistic review of a finished design.",
		],
	},
	canvas_screenshot: {
		description:
			"Render a pi-canvas frame or layer (default: every top-level layer of the document, side by side) to a PNG exactly as the editor draws it, including frame HTML with scripts, and return the image so you can see the design. Uses headless Chrome/Chromium (set PI_CANVAS_CHROME if it is not found). Saved under the canvas directory in shots/.",
		snippet: "See a pi-canvas frame, layer or whole document as a PNG image",
		guidelines: ["After creating or substantially changing a pi-canvas design, call canvas_screenshot on the changed frame and fix visible problems before reporting done."],
	},
} as const;

/** Field docs for an op's `node` (shared by the TypeBox and JSON Schema definitions). */
export const NODE_DOC =
	"add: layer to create. type: frame|group|text|note|rect|ellipse|polygon|path|image|icon|instance. " +
	"Common: x, y, w, h (relative to parentId, or canvas), parentId (a frame or group), name, rotation, opacity (0-1), visible, context. " +
	"Paint: fill (\"#hex\" or \"$variable\"), fills [{color,opacity}], stroke, strokeWidth, strokeAlign, radius, effects [{type:drop-shadow|inner-shadow|layer-blur|background-blur,x,y,blur,spread,color}]. " +
	"Frame: html (HTML document rendered inside) or htmlPath (read the HTML from a file, for big data visualizations), clip, layout {mode:vertical|horizontal, justify:start|center|end|between|around, align:start|center|end, gap, padding:[t,r,b,l]}, sizeW/sizeH fixed|hug|fill. " +
	"Text/note: text, fontFamily, fontWeight, fontSize, lineHeight, letterSpacing, textAlign, verticalAlign, color, textResize auto-width|auto-height|fixed. " +
	"polygon: sides. path: d (SVG path) + viewBox [w,h]. image: src. icon: icon (lucide name, e.g. \"star\"). instance: ref (component id); set isComponent:true on a layer to make it a component.";

export const OP_NAMES = [
	"add", "update", "delete", "set_report", "replace_in_report", "replace_in_node", "set_title", "clear_nodes",
	"set_variables", "add_comment", "update_comment", "delete_comment", "set_slide_order",
] as const;

export function resolveDoc(h: CoreHost, docId?: string): CanvasDoc {
	const s = h.store();
	const active = h.getActive();
	const doc = docId ? s.get(docId) : (active && s.get(active)) || s.latest();
	if (!doc) throw new Error(docId ? `unknown docId: ${docId}` : "no canvas documents yet; create one with canvas_report or canvas_new");
	return doc;
}

export async function canvasReport(
	h: CoreHost,
	params: { title: string; html?: string; path?: string; docId?: string; view?: "report" | "canvas" },
	browserNote = "The user can switch Report/Canvas views and chat with you from the browser; those messages arrive in this session with a <canvas_context> block.",
): Promise<ToolResult> {
	let html = params.html;
	if (!html && params.path) {
		const p = isAbsolute(params.path) ? params.path : resolve(h.cwd(), params.path);
		html = readFileSync(p, "utf8");
	}
	if (!html) throw new Error("canvas_report needs html or path");
	const s = h.store();
	const title = String(params.title ?? "Report");
	let doc: CanvasDoc;
	if (params.docId && s.get(params.docId)) {
		doc = h.applyOps(params.docId, [
			{ op: "set_report", html },
			{ op: "set_title", title },
		], "agent").doc;
	} else {
		doc = s.create(title, html);
		h.broadcast({ type: "docs", docs: s.list() });
	}
	const url = await h.show(doc.id, params.view ?? "report");
	return {
		content: [{ type: "text", text: `Opened "${doc.title}" (docId ${doc.id}, version ${doc.version}) at ${url}\nReport file: ${s.reportPath(doc.id)}\n${browserNote}` }],
		details: { docId: doc.id, url, version: doc.version },
	};
}

export function canvasRead(h: CoreHost, params: { docId?: string; full?: boolean }): ToolResult {
	const doc = resolveDoc(h, params.docId);
	const full = Boolean(params.full);
	const view = {
		id: doc.id,
		title: doc.title,
		version: doc.version,
		report: { chars: doc.reportHtml.length, outline: outline(doc.reportHtml), ...(full ? { html: doc.reportHtml } : {}) },
		variables: doc.variables ?? {},
		comments: (doc.comments ?? []).filter((c) => !c.resolved),
		slideOrder: doc.slideOrder,
		nodes: doc.nodes.map((n) => ({ ...n, html: full ? n.html : truncate(n.html, 300), d: full ? n.d : truncate(n.d, 200) })),
	};
	return { content: [{ type: "text", text: JSON.stringify(view, null, full ? 0 : 1) }], details: { docId: doc.id, version: doc.version } };
}

export async function canvasEdit(h: CoreHost, params: { docId?: string; ops: CanvasOp[] }): Promise<ToolResult> {
	const doc = resolveDoc(h, params.docId);
	if (!Array.isArray(params.ops)) throw new Error("canvas_edit needs an ops array");
	const res = h.applyOps(doc.id, params.ops.map((o) => withHtmlFiles(h, o)), "agent");
	if (!h.hasServer()) await h.show(doc.id);
	return { content: [{ type: "text", text: `${res.results.join("\n")}\nversion ${res.doc.version}` }], details: { docId: doc.id, version: res.doc.version, added: res.added } };
}

/** `htmlPath` on an added node / update props / set_report: read the HTML from a file (big data visualizations). */
function withHtmlFiles(h: CoreHost, op: CanvasOp): CanvasOp {
	const read = (p: unknown) => readFileSync(isAbsolute(String(p)) ? String(p) : resolve(h.cwd(), String(p)), "utf8");
	const o = op as any;
	if (o.node?.htmlPath) {
		const { htmlPath, ...node } = o.node;
		return { ...o, node: { ...node, html: read(htmlPath) } };
	}
	if (o.props?.htmlPath) {
		const { htmlPath, ...props } = o.props;
		return { ...o, props: { ...props, html: read(htmlPath) } };
	}
	if (o.op === "set_report" && !o.html && o.htmlPath) return { op: "set_report", html: read(o.htmlPath) } as CanvasOp;
	return op;
}

export async function canvasNew(
	h: CoreHost,
	params: { title: string; frames?: { name?: string; w?: number; h?: number; preset?: "desktop" | "tablet" | "mobile" }[] },
): Promise<ToolResult> {
	const s = h.store();
	let doc = s.create(String(params.title ?? "Design"), "");
	h.broadcast({ type: "docs", docs: s.list() });
	let x = 0;
	const ops: CanvasOp[] = (params.frames ?? []).map((f, i) => {
		const preset = (f.preset && f.preset in PRESETS ? f.preset : undefined) as keyof typeof PRESETS | undefined;
		const [pw, ph] = PRESETS[preset ?? "desktop"];
		const w = Math.max(1, Math.round(Number(f.w) || pw));
		const hh = Math.max(1, Math.round(Number(f.h) || ph));
		const name = f.name || (preset ? preset[0].toUpperCase() + preset.slice(1) : `Frame ${i + 1}`);
		const op: CanvasOp = { op: "add", node: { type: "frame", name, x, y: 0, w, h: hh } };
		x += w + FRAME_GAP;
		return op;
	});
	if (ops.length) doc = h.applyOps(doc.id, ops, "agent").doc;
	const url = await h.show(doc.id, "canvas");
	const frames = doc.nodes.map((n) => ({ id: n.id, name: n.name, w: n.w, h: n.h, x: n.x, y: n.y }));
	const lines = frames.map((f) => `frame ${f.id} ${JSON.stringify(f.name)} ${f.w}x${f.h} at (${f.x}, ${f.y})`);
	return {
		content: [
			{
				type: "text",
				text: `Created design "${doc.title}" (docId ${doc.id}, version ${doc.version}) at ${url}\n${lines.length ? `Frames:\n${lines.join("\n")}` : "No frames yet; add them with canvas_edit."}\nAdd layers inside a frame with canvas_edit add {node: {..., parentId: <frame id>}} (x/y relative to the frame).`,
			},
		],
		details: { docId: doc.id, url, version: doc.version, frames },
	};
}

export async function canvasScreenshot(h: CoreHost, params: { docId?: string; nodeId?: string; scale?: number }, signal?: AbortSignal): Promise<ToolResult> {
	const doc = resolveDoc(h, params.docId);
	const rect = targetRect(doc, params.nodeId);
	const chrome = findChrome();
	if (!chrome) {
		throw new Error(
			`canvas_screenshot needs Chrome, Chromium, Edge or Brave and found none${process.env.PI_CANVAS_CHROME ? ` (PI_CANVAS_CHROME=${process.env.PI_CANVAS_CHROME} does not exist)` : ""}; set PI_CANVAS_CHROME to the browser binary path`,
		);
	}
	const scale = params.scale === 2 ? 2 : 1;
	const url = await h.captureUrl(doc.id, params.nodeId);
	const out = join(h.store().dir, "shots", `${doc.id}-${(params.nodeId ?? "all").replace(/[^\w-]/g, "_")}.png`);
	const shot = await captureScreenshot({ chrome, url, width: rect.w, height: rect.h, scale, out, signal });
	const what = params.nodeId ? `node ${params.nodeId}` : "whole document";
	const cap = shot.capped ? ` (scale reduced to ${shot.scale.toFixed(3)} to stay within ${MAX_SIDE}px per side)` : "";
	const slow = shot.complete ? "" : "\nNote: some frame content was still loading when the shot was taken.";
	return {
		content: [
			{
				type: "text",
				text: `${shot.width}x${shot.height} PNG of ${what} in "${doc.title}" (world rect ${rect.w}x${rect.h} at (${rect.x}, ${rect.y}), scale ${scale}${cap})\nSaved to ${out}${slow}`,
			},
			{ type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
		],
		details: { docId: doc.id, nodeId: params.nodeId, path: out, width: shot.width, height: shot.height, scale: shot.scale },
	};
}

/** Fetch a page for "Import from URL", with a <base> so relative assets keep working. */
export async function importUrl(raw: string) {
	const url = new URL(raw);
	if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs can be imported");
	const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "pi-canvas/0.1 (+https://github.com/donghyeonan/pi-canvas)" } });
	if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
	let html = (await res.text()).slice(0, 3_000_000);
	const base = `<base href="${res.url.replace(/"/g, "&quot;")}">`;
	html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`;
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url.hostname;
	return { html, title, url: res.url };
}

/** Open a URL in the default browser (best effort; PI_CANVAS_NO_OPEN disables it). */
export function openBrowser(url: string) {
	if (process.env.PI_CANVAS_NO_OPEN) return;
	const [cmd, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", url]] // cmd /c start would split the URL at "&"
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args as string[], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no browser available; the URL is still shown in the footer and tool result
	}
}
