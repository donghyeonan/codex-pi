import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const NODE_TYPES = ["frame", "group", "text", "note", "rect", "ellipse", "polygon", "path", "image", "icon", "instance"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface Paint {
	color: string;
	opacity?: number;
	visible?: boolean;
}

export interface Effect {
	type: "drop-shadow" | "inner-shadow" | "layer-blur" | "background-blur";
	x?: number;
	y?: number;
	blur?: number;
	spread?: number;
	color?: string;
	visible?: boolean;
}

export interface FlexLayout {
	mode: "none" | "vertical" | "horizontal";
	justify?: "start" | "center" | "end" | "between" | "around";
	align?: "start" | "center" | "end";
	gap?: number;
	padding?: [number, number, number, number];
}

/**
 * One layer. Coordinates are relative to the parent (or the canvas for top-level nodes).
 * Top-level frames are artboards; frames with `html` render that HTML in a sandboxed iframe.
 */
export interface CanvasNode {
	id: string;
	type: NodeType;
	parentId?: string;
	name?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	z?: number;
	rotation?: number;
	flipX?: boolean;
	flipY?: boolean;
	opacity?: number;
	visible?: boolean;
	locked?: boolean;
	/** free-form notes for the agent ("Context" in the properties panel) */
	context?: string;
	// paint
	fill?: string;
	fills?: Paint[];
	stroke?: string;
	strokeWidth?: number;
	strokeWidths?: [number, number, number, number];
	strokeAlign?: "inside" | "outside" | "center";
	radius?: number;
	radii?: [number, number, number, number];
	effects?: Effect[];
	// frame
	html?: string;
	autoHeight?: boolean;
	clip?: boolean;
	layout?: FlexLayout;
	sizeW?: "fixed" | "hug" | "fill";
	sizeH?: "fixed" | "hug" | "fill";
	layoutPosition?: "auto" | "absolute";
	// text / note
	text?: string;
	fontFamily?: string;
	fontWeight?: number;
	fontSize?: number;
	lineHeight?: number;
	letterSpacing?: number;
	textAlign?: "left" | "center" | "right" | "justify";
	verticalAlign?: "top" | "middle" | "bottom";
	textResize?: "auto-width" | "auto-height" | "fixed";
	color?: string;
	// shapes
	sides?: number;
	d?: string;
	pathFit?: boolean;
	viewBox?: [number, number] | [number, number, number, number];
	// image / icon
	src?: string;
	fit?: "cover" | "contain" | "fill";
	icon?: string;
	// components
	isComponent?: boolean;
	ref?: string;
}

export interface CanvasComment {
	id: string;
	x: number;
	y: number;
	nodeId?: string;
	text: string;
	author?: string;
	createdAt: number;
	resolved?: boolean;
	replies?: { text: string; author?: string; createdAt: number }[];
}

export interface CanvasDoc {
	id: string;
	title: string;
	reportHtml: string;
	nodes: CanvasNode[];
	variables?: Record<string, string>;
	comments?: CanvasComment[];
	slideOrder?: string[];
	version: number;
	createdAt: number;
	updatedAt: number;
}

export interface DocSummary {
	id: string;
	title: string;
	updatedAt: number;
	nodes: number;
}

export type CanvasOp =
	| { op: "add"; node: Partial<CanvasNode> & { type: NodeType } }
	| { op: "update"; id: string; props: Partial<CanvasNode> }
	| { op: "delete"; id: string }
	| { op: "set_report"; html: string }
	| { op: "replace_in_report"; find: string; replace: string; all?: boolean }
	| { op: "replace_in_node"; id: string; find: string; replace: string; all?: boolean }
	| { op: "set_title"; title: string }
	| { op: "clear_nodes" }
	| { op: "set_nodes"; nodes: CanvasNode[] }
	| { op: "set_variables"; variables: Record<string, string> }
	| { op: "add_comment"; comment: Partial<CanvasComment> & { text: string } }
	| { op: "update_comment"; id: string; props: Partial<CanvasComment> }
	| { op: "delete_comment"; id: string }
	| { op: "set_slide_order"; ids: string[] };

export function newId(prefix = ""): string {
	return prefix + randomBytes(4).toString("hex");
}

const NODE_DEFAULTS: Record<NodeType, Partial<CanvasNode>> = {
	frame: { w: 720, h: 480, fill: "#ffffff", clip: true },
	group: { w: 100, h: 100 },
	text: { w: 160, h: 32, text: "Text", fontSize: 24, color: "#111111", textResize: "auto-width" },
	note: { w: 240, h: 200, text: "", fill: "#ffe28a", fontSize: 16, color: "#2b2b2b" },
	rect: { w: 200, h: 140, fill: "#d4d4d8" },
	ellipse: { w: 160, h: 160, fill: "#d4d4d8" },
	polygon: { w: 160, h: 140, fill: "#d4d4d8", sides: 3 },
	path: { w: 100, h: 100, stroke: "#e4e4e7", strokeWidth: 2 },
	image: { w: 320, h: 240, fit: "cover" },
	icon: { w: 24, h: 24, icon: "star", color: "#e4e4e7" },
	instance: { w: 100, h: 100 },
};

const NUMERIC = new Set([
	"x", "y", "w", "h", "z", "rotation", "opacity", "strokeWidth", "radius", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "sides",
]);
const BOOL = new Set(["autoHeight", "clip", "flipX", "flipY", "visible", "locked", "isComponent", "pathFit"]);
const COMPLEX = new Set(["fills", "effects", "layout", "radii", "viewBox", "strokeWidths"]);
const MAX_COMPLEX = 50_000;

function sanitizeProps(props: Record<string, unknown>): Partial<CanvasNode> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(props ?? {})) {
		if (k === "id" || k === "type") continue;
		if (v === null || v === undefined) {
			out[k] = undefined;
		} else if (NUMERIC.has(k)) {
			const n = Number(v);
			if (Number.isFinite(n)) out[k] = n;
		} else if (BOOL.has(k)) {
			out[k] = v === true || v === "true";
		} else if (COMPLEX.has(k)) {
			const json = JSON.stringify(v);
			if (json.length <= MAX_COMPLEX) out[k] = JSON.parse(json);
		} else if (typeof v === "string") {
			out[k] = v;
		} else if (typeof v === "number" || typeof v === "boolean") {
			out[k] = String(v);
		}
	}
	return out as Partial<CanvasNode>;
}

function replaceText(source: string, find: string, replace: string, all?: boolean): { text: string; count: number } {
	if (!find) throw new Error("find must be a non-empty string");
	let count = 0;
	let idx = source.indexOf(find);
	if (idx === -1) return { text: source, count: 0 };
	let out = "";
	let from = 0;
	while (idx !== -1) {
		out += source.slice(from, idx) + replace;
		from = idx + find.length;
		count++;
		if (!all) break;
		idx = source.indexOf(find, from);
	}
	return { text: out + source.slice(from), count };
}

function descendants(nodes: CanvasNode[], id: string): Set<string> {
	const out = new Set<string>();
	const stack = [id];
	while (stack.length) {
		const cur = stack.pop()!;
		for (const n of nodes) if (n.parentId === cur && !out.has(n.id)) {
			out.add(n.id);
			stack.push(n.id);
		}
	}
	return out;
}

const CONTAINERS = new Set<NodeType>(["frame", "group"]);

export class DocStore {
	private docs = new Map<string, CanvasDoc>();
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
		this.load();
	}

	private load() {
		if (!existsSync(this.dir)) return;
		for (const file of readdirSync(this.dir)) {
			if (!file.endsWith(".json")) continue;
			try {
				const doc = JSON.parse(readFileSync(join(this.dir, file), "utf8")) as CanvasDoc;
				if (doc?.id && Array.isArray(doc.nodes)) this.docs.set(doc.id, doc);
			} catch {
				// ignore unreadable files
			}
		}
	}

	private persist(doc: CanvasDoc) {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, `${doc.id}.json`), JSON.stringify(doc, null, 2));
		writeFileSync(join(this.dir, `${doc.id}.html`), doc.reportHtml);
	}

	list(): DocSummary[] {
		return [...this.docs.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((d) => ({ id: d.id, title: d.title, updatedAt: d.updatedAt, nodes: d.nodes.length }));
	}

	latest(): CanvasDoc | undefined {
		const first = this.list()[0];
		return first ? this.docs.get(first.id) : undefined;
	}

	get(id: string): CanvasDoc | undefined {
		return this.docs.get(id);
	}

	reportPath(id: string): string {
		return join(this.dir, `${id}.html`);
	}

	create(title: string, reportHtml: string): CanvasDoc {
		const now = Date.now();
		const doc: CanvasDoc = { id: newId(), title, reportHtml, nodes: [], variables: {}, comments: [], version: 1, createdAt: now, updatedAt: now };
		this.docs.set(doc.id, doc);
		this.persist(doc);
		return doc;
	}

	/** Apply ops atomically. Throws on the first invalid op without changing the doc. */
	apply(id: string, ops: CanvasOp[]): { doc: CanvasDoc; results: string[]; added: string[] } {
		const current = this.docs.get(id);
		if (!current) throw new Error(`unknown docId: ${id}`);
		const doc: CanvasDoc = structuredClone(current);
		doc.variables ??= {};
		doc.comments ??= [];
		const results: string[] = [];
		const added: string[] = [];
		const findNode = (nid: string) => {
			const n = doc.nodes.find((x) => x.id === nid);
			if (!n) throw new Error(`unknown node id: ${nid}`);
			return n;
		};
		const checkParent = (nodeId: string | undefined, parentId: string | undefined) => {
			if (!parentId) return;
			const p = findNode(parentId);
			if (!CONTAINERS.has(p.type)) throw new Error(`parent ${parentId} is a ${p.type}; only frames and groups can contain layers`);
			if (nodeId && (parentId === nodeId || descendants(doc.nodes, nodeId).has(parentId))) throw new Error("cannot move a layer into itself");
		};
		for (const raw of ops) {
			const op = raw as CanvasOp;
			switch (op.op) {
				case "add": {
					const type = op.node?.type;
					if (!type || !NODE_TYPES.includes(type)) throw new Error(`add: invalid node type ${String(type)}; use one of ${NODE_TYPES.join(", ")}`);
					const props = sanitizeProps(op.node as Record<string, unknown>);
					const requested = typeof op.node.id === "string" && op.node.id ? op.node.id : undefined;
					const nid = requested && !doc.nodes.some((n) => n.id === requested) ? requested : newId("n");
					checkParent(undefined, props.parentId);
					if (type === "instance" && props.ref) findNode(props.ref);
					const maxZ = doc.nodes.reduce((m, n) => Math.max(m, n.z ?? 0), 0);
					const node = { x: 0, y: 0, ...NODE_DEFAULTS[type], ...props, id: nid, type, z: props.z ?? maxZ + 1 } as CanvasNode;
					for (const k of Object.keys(node) as (keyof CanvasNode)[]) if (node[k] === undefined) delete node[k];
					doc.nodes.push(node);
					added.push(nid);
					results.push(`added ${type} ${nid}`);
					break;
				}
				case "update": {
					const n = findNode(op.id);
					const props = sanitizeProps((op.props ?? {}) as Record<string, unknown>);
					if ("parentId" in props) checkParent(n.id, props.parentId);
					if (props.ref) findNode(props.ref);
					Object.assign(n, props);
					for (const k of Object.keys(n) as (keyof CanvasNode)[]) if (n[k] === undefined) delete n[k];
					results.push(`updated ${op.id}`);
					break;
				}
				case "delete": {
					findNode(op.id);
					const gone = descendants(doc.nodes, op.id);
					gone.add(op.id);
					doc.nodes = doc.nodes.filter((n) => !gone.has(n.id));
					// instances of a deleted component become empty boxes; keep them but drop the ref
					for (const n of doc.nodes) if (n.ref && gone.has(n.ref)) delete n.ref;
					results.push(`deleted ${op.id}${gone.size > 1 ? ` and ${gone.size - 1} child layer(s)` : ""}`);
					break;
				}
				case "clear_nodes": {
					results.push(`cleared ${doc.nodes.length} nodes`);
					doc.nodes = [];
					break;
				}
				case "set_nodes": {
					if (!Array.isArray(op.nodes)) throw new Error("set_nodes: nodes array required");
					doc.nodes = op.nodes
						.filter((n) => n && typeof n.id === "string" && NODE_TYPES.includes(n.type))
						.map((n) => ({ ...sanitizeProps(n as unknown as Record<string, unknown>), id: n.id, type: n.type }) as CanvasNode);
					results.push(`set ${doc.nodes.length} nodes`);
					break;
				}
				case "set_report": {
					if (typeof op.html !== "string") throw new Error("set_report: html required");
					doc.reportHtml = op.html;
					results.push("report replaced");
					break;
				}
				case "replace_in_report": {
					const r = replaceText(doc.reportHtml, op.find, op.replace ?? "", op.all);
					if (r.count === 0) throw new Error("replace_in_report: find text not found in report");
					doc.reportHtml = r.text;
					results.push(`report: replaced ${r.count} occurrence(s)`);
					break;
				}
				case "replace_in_node": {
					const n = findNode(op.id);
					const field = n.type === "frame" ? "html" : "text";
					const r = replaceText(n[field] ?? "", op.find, op.replace ?? "", op.all);
					if (r.count === 0) throw new Error(`replace_in_node: find text not found in ${op.id}.${field}`);
					n[field] = r.text;
					results.push(`${op.id}: replaced ${r.count} occurrence(s)`);
					break;
				}
				case "set_title": {
					doc.title = String(op.title || doc.title);
					results.push("title set");
					break;
				}
				case "set_variables": {
					const vars: Record<string, string> = {};
					for (const [k, v] of Object.entries(op.variables ?? {})) if (/^[\w/.-]{1,128}$/.test(k)) vars[k] = String(v);
					doc.variables = vars;
					results.push(`set ${Object.keys(vars).length} variable(s)`);
					break;
				}
				case "add_comment": {
					if (!op.comment?.text) throw new Error("add_comment: text required");
					const c: CanvasComment = {
						id: newId("c"),
						x: Number(op.comment.x) || 0,
						y: Number(op.comment.y) || 0,
						nodeId: op.comment.nodeId,
						text: String(op.comment.text),
						author: op.comment.author ? String(op.comment.author) : "you",
						createdAt: Date.now(),
					};
					doc.comments.push(c);
					added.push(c.id);
					results.push(`added comment ${c.id}`);
					break;
				}
				case "update_comment": {
					const c = doc.comments.find((x) => x.id === op.id);
					if (!c) throw new Error(`unknown comment id: ${op.id}`);
					const p = op.props ?? {};
					if (typeof p.text === "string") c.text = p.text;
					if (typeof p.resolved === "boolean") c.resolved = p.resolved;
					if (Number.isFinite(p.x)) c.x = Number(p.x);
					if (Number.isFinite(p.y)) c.y = Number(p.y);
					if (Array.isArray(p.replies)) c.replies = p.replies.slice(0, 200).map((r) => ({ text: String(r.text), author: r.author, createdAt: Number(r.createdAt) || Date.now() }));
					results.push(`updated comment ${op.id}`);
					break;
				}
				case "delete_comment": {
					doc.comments = doc.comments.filter((c) => c.id !== op.id);
					results.push(`deleted comment ${op.id}`);
					break;
				}
				case "set_slide_order": {
					doc.slideOrder = (op.ids ?? []).filter((x) => typeof x === "string");
					results.push("slide order set");
					break;
				}
				default:
					throw new Error(`unknown op: ${(raw as { op?: string }).op}`);
			}
		}
		doc.version = current.version + 1;
		doc.updatedAt = Date.now();
		this.docs.set(id, doc);
		this.persist(doc);
		return { doc, results, added };
	}
}
