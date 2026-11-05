import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CanvasDoc, type CanvasNode, type CanvasOp, newId } from "./store.ts";

export const KIT_NAMES = ["shadcn", "halo", "lunaris", "nitro", "heroui"] as const;
export interface DesignKit {
	name: string;
	source: string;
	themes: Record<string, string[]>;
	variables: Record<string, Record<string, string>>;
	defaultTheme: string;
	components: { id: string; name: string; w: number; h: number }[];
	nodes: CanvasNode[];
	warnings: Record<string, number>;
}
const cache = new Map<string, DesignKit>();
const kitPath = (name: string) => fileURLToPath(new URL(`../kits/${name}.json`, import.meta.url));
const availableKits = () => KIT_NAMES.filter((name) => existsSync(kitPath(name)));
export function getKit(name: string): DesignKit {
	if (typeof name !== "string") throw new Error("kit must be a string");
	const key = name.toLowerCase();
	const available = availableKits().join(", ") || "none";
	if (!KIT_NAMES.includes(key as typeof KIT_NAMES[number])) throw new Error(`unknown kit: ${name}; available kits: ${available}`);
	if (!existsSync(kitPath(key))) throw new Error(`kit ${key} is not bundled with this installation; available kits: ${available}`);
	if (!cache.has(key)) cache.set(key, JSON.parse(readFileSync(kitPath(key), "utf8")));
	return cache.get(key)!;
}
export function listKits() {
	return availableKits().map((name) => {
		const k = getKit(name);
		return { name, components: k.components.length, tokens: Object.keys(k.variables[k.defaultTheme]), themes: Object.keys(k.variables), defaultTheme: k.defaultTheme };
	});
}
export function kitComponent(k: DesignKit, query: string) {
	const c = k.components.find((c) => c.id === query) ?? k.components.find((c) => c.name.toLowerCase() === query.toLowerCase());
	if (!c) throw new Error(`unknown component ${JSON.stringify(query)} in ${k.name}; list the kit for exact names`);
	return c;
}
/** Includes hidden override definitions used by instances, but never unrelated components. */
export function kitSubtree(k: DesignKit, roots: string[]): CanvasNode[] {
	const byId = new Map(k.nodes.map((n) => [n.id, n]));
	const children = new Map<string, CanvasNode[]>();
	for (const n of k.nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);
	const selected = new Set<string>();
	const visit = (id: string) => {
		if (selected.has(id)) return;
		const n = byId.get(id);
		if (!n) throw new Error(`kit ${k.name} has a missing node: ${id}`);
		selected.add(id);
		if (n.ref) visit(n.ref);
		for (const child of children.get(id) ?? []) visit(child.id);
	};
	roots.forEach(visit);
	// Parents and reference targets must exist before DocStore's add validation runs.
	const ordered: CanvasNode[] = [];
	const done = new Set<string>();
	const visiting = new Set<string>();
	const order = (id: string) => {
		if (done.has(id)) return;
		if (visiting.has(id)) throw new Error(`cyclic kit link: ${id}`);
		visiting.add(id);
		const n = byId.get(id)!;
		if (n.parentId && selected.has(n.parentId)) order(n.parentId);
		if (n.ref) order(n.ref);
		visiting.delete(id);
		done.add(id);
		ordered.push(n);
	};
	selected.forEach(order);
	return ordered;
}
export interface KitInsert {
	kit: string;
	insert: "all" | string[];
	x?: number;
	y?: number;
	theme?: string;
}
export function kitInsertOps(doc: CanvasDoc, options: KitInsert) {
	const k = getKit(options.kit);
	if (options.insert !== "all" && (!Array.isArray(options.insert) || !options.insert.length || options.insert.some((c) => typeof c !== "string"))) throw new Error("insert must be all or a non-empty component name array");
	const chosen = options.insert === "all" ? k.components : [...new Map(options.insert.map((q) => {
		const c = kitComponent(k, q);
		return [c.id, c] as const;
	})).values()];
	if (options.theme !== undefined && typeof options.theme !== "string") throw new Error("theme must be a string");
	const theme = options.theme === undefined ? k.defaultTheme : Object.keys(k.variables).find((t) => t.toLowerCase() === options.theme!.toLowerCase());
	if (!theme) throw new Error(`unknown theme: ${options.theme}; choose ${Object.keys(k.variables).join(", ")}`);
	for (const value of [options.x, options.y]) if (value !== undefined && !Number.isFinite(value)) throw new Error("x/y must be finite numbers");
	const nodes = kitSubtree(k, chosen.map((c) => c.id));
	const ids = new Map(nodes.map((n) => [n.id, newId("k")]));
	const positions = new Map<string, { x: number; y: number }>();
	const startX = options.x ?? 0;
	const startY = options.y ?? Math.max(0, ...doc.nodes.filter((n) => !n.parentId && n.visible !== false).map((n) => n.y + n.h + 80));
	let x = 0, y = 0, rowH = 0;
	for (const c of chosen) {
		if (x && x + c.w > 2400) { x = 0; y += rowH + 64; rowH = 0; }
		positions.set(c.id, { x: startX + x, y: startY + y });
		x += Math.max(c.w, 80) + 48;
		rowH = Math.max(rowH, c.h);
	}
	const ops: CanvasOp[] = nodes.map((n) => ({ op: "add", node: {
		...structuredClone(n), id: ids.get(n.id)!, parentId: n.parentId ? ids.get(n.parentId) : undefined,
		ref: n.ref ? ids.get(n.ref) : undefined, ...positions.get(n.id),
		isComponent: positions.has(n.id),
	} }));
	ops.push({ op: "set_variables", variables: { ...doc.variables, ...k.variables[theme] } });
	return { ops, kit: k.name, theme, inserted: chosen.map((c) => ({ ...c, id: ids.get(c.id)! })) };
}

/** Reuse CanvasServer's authenticated extension API; UI and agent share kitInsertOps/applyOps. */
export function kitApi(path: string, method: string, body: any, doc: (id?: string) => CanvasDoc, apply: (id: string, ops: CanvasOp[]) => { doc: CanvasDoc }) {
	if (path === "kits" && method === "GET") return listKits();
	if (path === "kits/insert" && method === "POST") {
		if (typeof body?.kit !== "string") throw new Error("kit is required");
		const d = doc(body.docId);
		const { ops, ...result } = kitInsertOps(d, body);
		return { ...result, doc: apply(d.id, ops).doc };
	}
	throw new Error("unknown kit endpoint");
}
