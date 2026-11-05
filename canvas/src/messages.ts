/**
 * Converts Pi session messages into a small, UI-friendly JSON shape for the browser.
 * Kept structural (no imports from Pi) so it tolerates message shapes added in later versions.
 */

export interface UiToolCall {
	id: string;
	name: string;
	args: unknown;
}

export interface UiMessage {
	key: string;
	role: "user" | "assistant" | "toolResult" | "custom";
	text: string;
	thinking?: string;
	tools?: UiToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	customType?: string;
	images?: number;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	ts: number;
}

type AnyMsg = Record<string, any>;

function blocksToText(content: unknown): { text: string; images: number } {
	if (typeof content === "string") return { text: content, images: 0 };
	if (!Array.isArray(content)) return { text: "", images: 0 };
	let text = "";
	let images = 0;
	for (const b of content) {
		if (b?.type === "text" && typeof b.text === "string") text += (text ? "\n" : "") + b.text;
		else if (b?.type === "image") images++;
	}
	return { text, images };
}

const MAX_RESULT = 4000;

export function toUiMessage(msg: AnyMsg | undefined, fallbackKey?: string): UiMessage | undefined {
	if (!msg || typeof msg !== "object") return undefined;
	const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
	const role = msg.role;
	if (role === "user") {
		const { text, images } = blocksToText(msg.content);
		return { key: fallbackKey ?? `user:${ts}`, role, text, images: images || undefined, ts };
	}
	if (role === "assistant") {
		let text = "";
		let thinking = "";
		const tools: UiToolCall[] = [];
		for (const b of Array.isArray(msg.content) ? msg.content : []) {
			if (b?.type === "text") text += b.text ?? "";
			else if (b?.type === "thinking") thinking += b.thinking ?? "";
			else if (b?.type === "toolCall") tools.push({ id: b.id, name: b.name, args: b.arguments });
		}
		return {
			key: fallbackKey ?? `assistant:${ts}`,
			role,
			text,
			thinking: thinking || undefined,
			tools: tools.length ? tools : undefined,
			model: msg.model,
			stopReason: msg.stopReason,
			errorMessage: msg.errorMessage,
			ts,
		};
	}
	if (role === "toolResult") {
		let { text } = blocksToText(msg.content);
		if (text.length > MAX_RESULT) text = `${text.slice(0, MAX_RESULT)}\n… (${text.length - MAX_RESULT} more chars)`;
		return {
			key: fallbackKey ?? `toolResult:${msg.toolCallId ?? ts}`,
			role,
			text,
			toolCallId: msg.toolCallId,
			toolName: msg.toolName,
			isError: Boolean(msg.isError),
			ts,
		};
	}
	if (role === "custom") {
		if (msg.display === false) return undefined;
		const { text } = blocksToText(msg.content);
		return { key: fallbackKey ?? `custom:${ts}`, role, text, customType: msg.customType, ts };
	}
	return undefined;
}

/** Build the visible transcript from the current session branch. */
export function branchToUi(entries: readonly AnyMsg[]): UiMessage[] {
	const out: UiMessage[] = [];
	for (const e of entries) {
		if (e?.type === "message") {
			const m = toUiMessage(e.message);
			if (m) out.push(m);
		} else if (e?.type === "custom_message" && e.display) {
			const { text } = blocksToText(e.content);
			out.push({ key: `custom:${e.id}`, role: "custom", text, customType: e.customType, ts: Date.parse(e.timestamp) || 0 });
		} else if (e?.type === "compaction") {
			out.push({ key: `custom:${e.id}`, role: "custom", text: "Context compacted", customType: "compaction", ts: Date.parse(e.timestamp) || 0 });
		}
	}
	return out;
}
