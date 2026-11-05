/**
 * Attach to a live Codex CLI session through Codex's shared app-server daemon.
 *
 * The Codex TUI runs its sessions ("threads") inside a per-user app-server daemon and talks to it over
 * JSON-RPC on a WebSocket at $CODEX_HOME/app-server-control/app-server-control.sock. Any other client
 * can join a loaded thread with thread/resume, then receives the same item/turn notifications as the TUI,
 * and turn/start from that client lands in the TUI's transcript as if typed there. That is what makes the
 * canvas chat the same session as the terminal, exactly like the pi extension does with pi.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import type { UiMessage } from "../messages.ts";
import { daemonSocket } from "./paths.ts";
import { type ByteStream, MiniWebSocket, streamOf } from "./ws.ts";


type Json = Record<string, any>;
const MAX_RESULT = 4000;
const clip = (t: string) => (t.length > MAX_RESULT ? `${t.slice(0, MAX_RESULT)}\n… (${t.length - MAX_RESULT} more chars)` : t);

export interface BridgeEvents {
	/** a UI event for the browser (message / busy / model / session / snapshot) */
	emit(event: unknown): void;
	log?(line: string): void;
}

export interface ThreadInfo {
	id: string;
	name?: string;
	cwd?: string;
	model?: string;
	provider?: string;
}

/** What the browser shows for one Codex thread item. Tool-like items become an assistant tool call + its result. */
export function itemToUi(item: Json, turnId?: string, ts = Date.now()): UiMessage[] {
	// item ids are only unique within a turn
	const id = turnId ? `${turnId}:${item.id}` : String(item.id);
	const t = item.startedAtMs ?? item.completedAtMs ?? ts;
	switch (item.type) {
		case "userMessage": {
			let text = "";
			let images = 0;
			for (const c of item.content ?? []) {
				if (c.type === "text") text += (text ? "\n" : "") + c.text;
				else if (c.type === "image" || c.type === "localImage") images++;
				else if ((c.type === "skill" || c.type === "mention") && !text.includes(`$${c.name}`)) text += `${text ? " " : ""}$${c.name}`;
			}
			return [{ key: `user:${id}`, role: "user", text, images: images || undefined, ts: t }];
		}
		case "agentMessage":
			return [{ key: `assistant:${id}`, role: "assistant", text: item.text ?? "", ts: t }];
		case "reasoning": {
			const thinking = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
			return thinking ? [{ key: `assistant:${id}`, role: "assistant", text: "", thinking, ts: t }] : [];
		}
		case "plan":
			return item.text ? [{ key: `custom:${id}`, role: "custom", customType: "plan", text: item.text, ts: t }] : [];
		case "contextCompaction":
			return [{ key: `custom:${id}`, role: "custom", customType: "compaction", text: "Context compacted", ts: t }];
	}
	const tool = toolOf(item);
	if (!tool) return [];
	const out: UiMessage[] = [{ key: `assistant:${id}`, role: "assistant", text: "", tools: [{ id, name: tool.name, args: tool.args }], ts: t }];
	if (tool.done) out.push({ key: `toolResult:${id}`, role: "toolResult", text: clip(tool.result), toolCallId: id, toolName: tool.name, isError: tool.error, ts: item.completedAtMs ?? t });
	return out;
}

function toolOf(item: Json): { name: string; args: unknown; done: boolean; result: string; error: boolean } | undefined {
	const status = String(item.status ?? "");
	const done = !/progress|pending|running/i.test(status) || status === "";
	switch (item.type) {
		case "mcpToolCall": {
			const text = (item.result?.content ?? []).map((c: Json) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).filter(Boolean).join("\n");
			return { name: item.tool, args: item.arguments, done, result: item.error?.message ?? text, error: Boolean(item.error) || /fail/i.test(status) };
		}
		case "commandExecution": {
			const out = item.aggregatedOutput ?? "";
			const code = item.exitCode;
			return { name: "shell", args: { command: item.command, cwd: item.cwd }, done, result: `${out}${code != null && code !== 0 ? `\nexit code ${code}` : ""}`, error: (code != null && code !== 0) || /fail|declined/i.test(status) };
		}
		case "fileChange":
			return { name: "apply_patch", args: { files: (item.changes ?? []).map((c: Json) => c.path) }, done, result: `${(item.changes ?? []).map((c: Json) => `${c.kind?.type ?? c.kind ?? "update"} ${c.path}`).join("\n")}\n${status}`, error: /fail|declined/i.test(status) };
		case "dynamicToolCall":
			return { name: item.tool, args: item.arguments, done, result: (item.contentItems ?? []).map((c: Json) => c.text ?? "").join("\n"), error: item.success === false };
		case "webSearch":
			return { name: "web_search", args: { query: item.query ?? item.action?.query }, done: true, result: "", error: false };
		case "imageView":
			return { name: "view_image", args: { path: item.path }, done: true, result: "", error: false };
		case "collabAgentToolCall":
			return { name: item.tool ?? "agent", args: { prompt: item.prompt }, done, result: "", error: false };
	}
	return undefined;
}

export class CodexBridge {
	private ws: MiniWebSocket | undefined;
	private connecting: Promise<void> | undefined;
	private seq = 0;
	private calls = new Map<number, { resolve(v: any): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
	private ev: BridgeEvents;
	/** live state of the attached thread */
	thread: ThreadInfo | undefined;
	live = false;
	busy = false;
	activeTurnId: string | undefined;
	messages: UiMessage[] = [];
	private streaming = new Map<string, UiMessage>();
	private flushTimer: NodeJS.Timeout | undefined;

	constructor(ev: BridgeEvents) {
		this.ev = ev;
	}

	get connected() {
		return Boolean(this.ws && !this.ws.closed);
	}

	/** Connect to the daemon (unix socket directly, or `codex app-server proxy` where that is not possible). */
	async connect(): Promise<void> {
		if (this.connected) return;
		if (this.connecting) return this.connecting;
		this.connecting = (async () => {
			const stream = await openStream();
			const ws = new MiniWebSocket(stream);
			await ws.connect();
			ws.on("message", (raw: string) => this.onMessage(raw));
			ws.on("close", () => {
				if (this.ws !== ws) return;
				this.ws = undefined;
				this.live = false;
				for (const c of this.calls.values()) c.reject(new Error("codex app-server connection closed"));
				this.calls.clear();
				this.ev.emit({ type: "session", name: this.sessionName() });
			});
			this.ws = ws;
			await this.request("initialize", { clientInfo: { name: "pi_canvas", title: "pi canvas", version: "0.1.0" }, capabilities: { experimentalApi: true } });
			ws.send(JSON.stringify({ method: "initialized" }));
		})();
		try {
			await this.connecting;
		} finally {
			this.connecting = undefined;
		}
	}

	close() {
		this.ws?.close();
		this.ws = undefined;
	}

	request<T = any>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
		const ws = this.ws;
		if (!ws || ws.closed) return Promise.reject(new Error("not connected to the codex app-server"));
		const id = ++this.seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.calls.delete(id);
				reject(new Error(`codex app-server: ${method} timed out`));
			}, timeoutMs);
			this.calls.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify({ id, method, params }));
		});
	}

	sessionName() {
		const t = this.thread;
		if (!t) return "Codex · no session attached";
		return `Codex · ${t.name || t.id.slice(0, 8)}${this.live ? "" : " (offline)"}`;
	}

	/**
	 * Join a Codex thread. Only threads already loaded in the daemon are joined (that is the TUI's live
	 * session); anything else would make the daemon a second writer of a session another process owns.
	 */
	async attach(threadId: string, hint?: { cwd?: string }): Promise<boolean> {
		if (this.thread?.id === threadId && this.live && this.connected) return true;
		this.thread = { id: threadId, cwd: hint?.cwd };
		this.live = false;
		this.busy = false;
		this.activeTurnId = undefined;
		this.messages = [];
		this.streaming.clear();
		try {
			await this.connect();
			const loaded = await this.request<{ data: string[] }>("thread/loaded/list", {});
			if (!loaded.data?.includes(threadId)) {
				this.ev.log?.(`thread ${threadId} is not loaded in the codex daemon; staying offline`);
				return false;
			}
			const r = await this.request<Json>("thread/resume", { threadId, excludeTurns: true });
			const th = r.thread ?? {};
			const cwd = r.cwd ?? hint?.cwd;
			this.thread = { id: threadId, name: th.name || (cwd ? String(cwd).split(/[\\/]/).filter(Boolean).pop() : undefined), cwd, model: r.model, provider: r.modelProvider };
			this.busy = th.status?.type === "active";
			this.live = true;
			this.messages = await this.history(threadId);
			return true;
		} catch (err) {
			this.ev.log?.(`attach ${threadId} failed: ${(err as Error).message}`);
			return false;
		} finally {
			this.ev.emit({ type: "snapshot-changed" });
		}
	}

	private async history(threadId: string): Promise<UiMessage[]> {
		try {
			const page = await this.request<{ data: { item: Json; startedAtMs: number | null; completedAtMs: number | null }[] }>("thread/items/list", { threadId, limit: 300, sortDirection: "desc" });
			const entries = [...(page.data ?? [])].reverse();
			return entries.flatMap((e: any) => itemToUi({ ...e.item, startedAtMs: e.item.startedAtMs ?? e.startedAtMs, completedAtMs: e.item.completedAtMs ?? e.completedAtMs }, e.turnId));
		} catch (err) {
			this.ev.log?.(`history: ${(err as Error).message}`);
			return [];
		}
	}

	/**
	 * No canvas tool has run yet (e.g. the workspace was opened with `codex-canvas open`): join the most recently
	 * active top-level session loaded in the daemon, which is the Codex terminal the user is working in.
	 */
	async attachLatest(): Promise<boolean> {
		try {
			await this.connect();
			const loaded = await this.request<{ data: string[] }>("thread/loaded/list", {});
			let best: { id: string; at: number } | undefined;
			for (const id of loaded.data ?? []) {
				const r = await this.request<Json>("thread/read", { threadId: id }).catch(() => undefined);
				const th = r?.thread;
				if (!th || th.ephemeral || th.parentThreadId) continue;
				const at = Number(th.updatedAt ?? 0);
				if (!best || at > best.at) best = { id, at };
			}
			return best ? await this.attach(best.id) : false;
		} catch (err) {
			this.ev.log?.(`attachLatest: ${(err as Error).message}`);
			return false;
		}
	}

	/** Send a browser message into the session. turn/start adds to an active turn (steer) or starts a new one. */
	async prompt(input: Json[]): Promise<{ ok: boolean; error?: string; queued?: boolean }> {
		if (!this.thread) await this.attachLatest();
		const t = this.thread;
		if (!t) return { ok: false, error: "no Codex session attached yet — run $canvas (or any canvas tool) in Codex first" };
		if (!this.live && !(await this.attach(t.id, { cwd: t.cwd }))) return { ok: false, error: "this Codex session is not running in the shared app-server daemon (is the terminal session still open?)" };
		const wasBusy = this.busy;
		try {
			if (wasBusy && this.activeTurnId) {
				try {
					await this.request("turn/steer", { threadId: t.id, input, expectedTurnId: this.activeTurnId });
					return { ok: true, queued: true };
				} catch {
					// turn ended meanwhile: start a new one below
				}
			}
			await this.request("turn/start", { threadId: t.id, input });
			return { ok: true, queued: wasBusy };
		} catch (err) {
			return { ok: false, error: (err as Error).message };
		}
	}

	async interrupt() {
		const t = this.thread;
		if (!t || !this.activeTurnId) return;
		try {
			await this.request("turn/interrupt", { threadId: t.id, turnId: this.activeTurnId });
		} catch (err) {
			this.ev.log?.(`interrupt: ${(err as Error).message}`);
		}
	}

	// ---- incoming -------------------------------------------------------------------------

	private onMessage(raw: string) {
		let m: Json;
		try {
			m = JSON.parse(raw);
		} catch {
			return;
		}
		if (m.id !== undefined && (m.result !== undefined || m.error) && !m.method) {
			const c = this.calls.get(Number(m.id));
			if (!c) return;
			this.calls.delete(Number(m.id));
			clearTimeout(c.timer);
			if (m.error) c.reject(new Error(m.error.message ?? JSON.stringify(m.error)));
			else c.resolve(m.result);
			return;
		}
		// server requests (approvals etc.) are answered by the terminal; notifications are mirrored
		if (m.method && m.id === undefined) this.onNotification(m.method, m.params ?? {});
	}

	private upsert(msg: UiMessage, phase: "start" | "update" | "end") {
		const i = this.messages.findIndex((x) => x.key === msg.key);
		if (i === -1) this.messages.push(msg);
		else this.messages[i] = msg;
		if (this.messages.length > 1000) this.messages.splice(0, this.messages.length - 1000);
		if (phase === "update") {
			this.streaming.set(msg.key, msg);
			this.flushTimer ??= setTimeout(() => this.flush(), 50);
		} else {
			this.streaming.delete(msg.key);
			this.ev.emit({ type: "message", phase, message: msg });
		}
	}

	private flush() {
		this.flushTimer = undefined;
		for (const m of this.streaming.values()) this.ev.emit({ type: "message", phase: "update", message: m });
		this.streaming.clear();
	}

	private setBusy(b: boolean) {
		if (this.busy === b) return;
		this.busy = b;
		this.ev.emit({ type: "busy", busy: b });
	}

	private onNotification(method: string, p: Json) {
		const t = this.thread;
		if (!t || (p.threadId && p.threadId !== t.id)) return;
		switch (method) {
			case "turn/started":
				this.activeTurnId = p.turn?.id;
				this.setBusy(true);
				break;
			case "turn/completed":
				if (this.flushTimer) {
					clearTimeout(this.flushTimer);
					this.flush();
				}
				if (!this.activeTurnId || p.turn?.id === this.activeTurnId) this.activeTurnId = undefined;
				if (p.turn?.error?.message) this.upsert({ key: `custom:err:${p.turn.id}`, role: "custom", customType: "error", text: p.turn.error.message, ts: Date.now() }, "end");
				this.setBusy(false);
				break;
			case "thread/status/changed":
				this.setBusy(p.status?.type === "active");
				break;
			case "thread/name/updated":
				t.name = p.threadName ?? p.name ?? t.name;
				this.ev.emit({ type: "session", name: this.sessionName() });
				break;
			case "thread/settings/updated":
				if (p.settings?.model || p.model) {
					t.model = p.settings?.model ?? p.model;
					this.ev.emit({ type: "model", model: { id: t.model, name: t.model, provider: t.provider } });
				}
				break;
			case "thread/closed":
				this.live = false;
				this.setBusy(false);
				this.ev.emit({ type: "session", name: this.sessionName() });
				break;
			case "item/started":
			case "item/completed":
				for (const ui of itemToUi(p.item ?? {}, p.turnId)) this.upsert(this.merge(ui), method === "item/started" && ui.role !== "toolResult" ? "start" : "end");
				break;
			case "item/agentMessage/delta": {
				const key = `assistant:${p.turnId ? `${p.turnId}:` : ""}${p.itemId}`;
				const cur = this.messages.find((x) => x.key === key) ?? { key, role: "assistant" as const, text: "", ts: Date.now() };
				this.upsert({ ...cur, text: cur.text + (p.delta ?? "") }, "update");
				break;
			}
			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta": {
				const key = `assistant:${p.turnId ? `${p.turnId}:` : ""}${p.itemId}`;
				const cur = this.messages.find((x) => x.key === key) ?? { key, role: "assistant" as const, text: "", ts: Date.now() };
				this.upsert({ ...cur, thinking: (cur.thinking ?? "") + (p.delta ?? "") }, "update");
				break;
			}
			case "error":
				if (p.error?.message && !p.willRetry) this.upsert({ key: `custom:err:${Date.now()}`, role: "custom", customType: "error", text: p.error.message, ts: Date.now() }, "end");
				break;
		}
	}

	/** keep streamed text/thinking when a started/completed item carries less than what was streamed */
	private merge(ui: UiMessage): UiMessage {
		const cur = this.messages.find((x) => x.key === ui.key);
		if (!cur) return ui;
		return { ...ui, text: ui.text || cur.text, thinking: ui.thinking || cur.thinking, ts: cur.ts };
	}
}

async function openStream(): Promise<ByteStream> {
	const path = daemonSocket();
	// AF_UNIX paths are limited to ~104-108 bytes; Windows has no unix sockets in node. Use the proxy then.
	if (process.platform !== "win32" && Buffer.byteLength(path) < 100) {
		if (!existsSync(path)) throw new Error(`codex app-server daemon is not running (no ${path})`);
		const sock = connect(path);
		await new Promise<void>((resolve, reject) => {
			sock.once("connect", resolve);
			sock.once("error", reject);
		});
		return streamOf(sock);
	}
	const bin = process.env.PI_CANVAS_CODEX_BIN || "codex";
	const child = spawn(bin, ["app-server", "proxy"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: process.platform === "win32" });
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	return { readable: child.stdout!, writable: child.stdin!, destroy: () => child.kill() };
}
