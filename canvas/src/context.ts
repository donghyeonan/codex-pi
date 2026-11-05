// Shared helpers for turning browser selection into prompt context.

export function outline(html: string): string[] {
	const out: string[] = [];
	const re = /<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && out.length < 60) {
		const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		if (text) out.push(`${"  ".repeat(Number(m[1]) - 1)}${text}`);
	}
	return out;
}

export function truncate(s: string | undefined, n: number) {
	if (!s) return s;
	return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

export interface CanvasContext {
	docId?: string;
	view?: string;
	nodes?: { id: string; type?: string; name?: string; context?: string }[];
	comment?: { id: string; text: string };
	element?: { selector?: string; html?: string; text?: string };
}

export function renderContext(ctx: CanvasContext | undefined): string {
	if (!ctx || (!ctx.docId && !ctx.nodes?.length && !ctx.element && !ctx.comment)) return "";
	const lines: string[] = [];
	const attrs = [`doc="${ctx.docId ?? ""}"`, `view="${ctx.view ?? "report"}"`].join(" ");
	if (ctx.nodes?.length) {
		lines.push(
			`selected nodes: ${ctx.nodes
				.slice(0, 30)
				.map((n) => `${n.id} (${n.type ?? "node"}${n.name ? ` "${n.name}"` : ""})`)
				.join(", ")}`,
		);
	}
	for (const n of ctx.nodes ?? []) if (n.context) lines.push(`context for ${n.id}: ${truncate(n.context, 600)}`);
	if (ctx.comment?.text) lines.push(`about comment ${ctx.comment.id}: ${truncate(ctx.comment.text, 600)}`);
	if (ctx.element?.selector) {
		lines.push(`selected report element: ${ctx.element.selector}`);
		if (ctx.element.html) lines.push("```html", truncate(ctx.element.html, 1500) ?? "", "```");
	}
	return `\n\n<canvas_context ${attrs}>${lines.length ? `\n${lines.join("\n")}\n` : ""}</canvas_context>`;
}

