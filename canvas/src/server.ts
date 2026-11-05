import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { AddressInfo } from "node:net";

export interface PromptRequest {
	text: string;
	context?: unknown;
	images?: { data: string; mimeType: string }[];
}

export type PromptResult = { ok: boolean; error?: string; queued?: boolean };

export interface ServerHandlers {
	snapshot(): unknown;
	listDocs(): unknown;
	getDoc(id: string): unknown | undefined;
	createDoc(title: string, html: string): unknown;
	applyOps(id: string, ops: unknown[], baseVersion?: number): unknown;
	prompt(req: PromptRequest): PromptResult | Promise<PromptResult>;
	abort(): void | Promise<void>;
	skills(): unknown;
	/** Optional extra API under /api/agent/* (used by the standalone host). */
	agentApi?(path: string, method: string, body: any, url: URL): Promise<unknown> | unknown;
	importUrl(url: string): Promise<{ html: string; title: string; url: string }>;
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".json": "application/json; charset=utf-8",
};

const MAX_BODY = 25 * 1024 * 1024;

export class CanvasServer {
	private server: Server | undefined;
	private clients = new Set<ServerResponse>();
	private heartbeat: NodeJS.Timeout | undefined;
	port = 0;

	private readonly webDir: string;
	private readonly token: string;
	private readonly handlers: ServerHandlers;

	constructor(webDir: string, token: string, handlers: ServerHandlers) {
		this.webDir = webDir;
		this.token = token;
		this.handlers = handlers;
	}

	get clientCount() {
		return this.clients.size;
	}

	url(docId?: string, view?: string): string {
		const hash = docId ? `#doc=${docId}${view ? `&view=${view}` : ""}` : "";
		return `http://127.0.0.1:${this.port}/?t=${this.token}${hash}`;
	}

	/** UI-free capture view of one layer (or every top-level layer) for canvas_screenshot. */
	captureUrl(docId: string, nodeId?: string): string {
		const node = nodeId ? `&node=${encodeURIComponent(nodeId)}` : "";
		return `http://127.0.0.1:${this.port}/?t=${this.token}&capture=1&doc=${encodeURIComponent(docId)}${node}`;
	}

	async start(preferredPort: number): Promise<number> {
		const server = createServer((req, res) => {
			this.handle(req, res).catch((err) => {
				if (!res.headersSent) this.json(res, 500, { error: String(err?.message ?? err) });
				else res.end();
			});
		});
		const listen = (port: number) =>
			new Promise<number>((resolve, reject) => {
				const onError = (err: NodeJS.ErrnoException) => {
					server.off("listening", onListening);
					reject(err);
				};
				const onListening = () => {
					server.off("error", onError);
					resolve((server.address() as AddressInfo).port);
				};
				server.once("error", onError);
				server.once("listening", onListening);
				// PI_CANVAS_HOST=0.0.0.0 for a remote container whose port is forwarded to your browser
				server.listen(port, process.env.PI_CANVAS_HOST || "127.0.0.1");
			});
		// the preferred port, then the next few, then any free port
		let port = 0;
		for (let i = 0; i <= 10; i++) {
			const p = i < 10 && preferredPort ? preferredPort + i : 0;
			try {
				port = await listen(p);
				break;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || p === 0) throw err;
			}
		}
		this.server = server;
		this.port = port;
		this.heartbeat = setInterval(() => this.broadcastRaw(": ping\n\n"), 15000);
		this.heartbeat.unref?.();
		server.unref();
		return port;
	}

	async stop(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat);
		for (const c of this.clients) c.end();
		this.clients.clear();
		const s = this.server;
		this.server = undefined;
		if (s) await new Promise<void>((r) => s.close(() => r()));
		s?.closeAllConnections?.();
	}

	broadcast(event: unknown) {
		this.broadcastRaw(`data: ${JSON.stringify(event)}\n\n`);
	}

	private broadcastRaw(chunk: string) {
		for (const c of this.clients) c.write(chunk);
	}

	private json(res: ServerResponse, status: number, body: unknown) {
		res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		res.end(JSON.stringify(body));
	}

	private async readBody(req: IncomingMessage): Promise<any> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req) {
			size += (chunk as Buffer).length;
			if (size > MAX_BODY) throw new Error("request body too large");
			chunks.push(chunk as Buffer);
		}
		const raw = Buffer.concat(chunks).toString("utf8");
		return raw ? JSON.parse(raw) : {};
	}

	private authorized(req: IncomingMessage, url: URL): boolean {
		// Dev/demo only: lets preview panes that cannot carry the token in the URL reach the API.
		if (process.env.PI_CANVAS_NO_AUTH === "1") return true;
		const t = req.headers["x-pi-canvas-token"] ?? url.searchParams.get("t");
		return t === this.token;
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const path = url.pathname;

		if (path.startsWith("/api/")) {
			if (!this.authorized(req, url)) return this.json(res, 401, { error: "unauthorized" });
			return this.api(req, res, url);
		}

		if (req.method !== "GET" && req.method !== "HEAD") return this.json(res, 405, { error: "method not allowed" });
		const rel = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
		const file = normalize(join(this.webDir, rel));
		if (!file.startsWith(this.webDir + sep) && file !== this.webDir) return this.json(res, 403, { error: "forbidden" });
		try {
			const body = await readFile(file);
			res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
			res.end(body);
		} catch {
			this.json(res, 404, { error: "not found" });
		}
	}

	private async api(req: IncomingMessage, res: ServerResponse, url: URL) {
		const h = this.handlers;
		const path = url.pathname;
		const method = req.method ?? "GET";

		if (path === "/api/events" && method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-store",
				connection: "keep-alive",
			});
			res.write(`retry: 1000\ndata: ${JSON.stringify({ type: "snapshot", ...(h.snapshot() as object) })}\n\n`);
			this.clients.add(res);
			req.on("close", () => this.clients.delete(res));
			return;
		}
		if (path === "/api/state" && method === "GET") return this.json(res, 200, h.snapshot());
		if (path === "/api/docs" && method === "GET") return this.json(res, 200, h.listDocs());
		if (path === "/api/docs" && method === "POST") {
			const body = await this.readBody(req);
			return this.json(res, 200, h.createDoc(String(body.title ?? "Untitled"), String(body.html ?? "")));
		}
		const docMatch = path.match(/^\/api\/docs\/([A-Za-z0-9_-]+)(\/ops)?$/);
		if (docMatch) {
			const id = docMatch[1];
			if (!docMatch[2] && method === "GET") {
				const doc = h.getDoc(id);
				return doc ? this.json(res, 200, doc) : this.json(res, 404, { error: "not found" });
			}
			if (docMatch[2] && method === "POST") {
				const body = await this.readBody(req);
				try {
					return this.json(res, 200, h.applyOps(id, Array.isArray(body.ops) ? body.ops : [], body.baseVersion));
				} catch (err) {
					return this.json(res, 400, { error: String((err as Error).message ?? err) });
				}
			}
		}
		if (path === "/api/prompt" && method === "POST") {
			const body = await this.readBody(req);
			const images = Array.isArray(body.images)
				? body.images
						.filter((i: any) => typeof i?.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i?.mimeType))
						.slice(0, 8)
						.map((i: any) => ({ data: String(i.data), mimeType: String(i.mimeType) }))
				: undefined;
			const result = await h.prompt({ text: String(body.text ?? ""), context: body.context, images });
			return this.json(res, result.ok ? 200 : 409, result);
		}
		if (path === "/api/skills" && method === "GET") return this.json(res, 200, h.skills());
		if (path.startsWith("/api/agent/") && h.agentApi) {
			try {
				const body = method === "POST" ? await this.readBody(req) : {};
				return this.json(res, 200, await h.agentApi(path.slice("/api/agent/".length), method, body, url));
			} catch (err) {
				return this.json(res, 400, { error: String((err as Error).message ?? err) });
			}
		}
		if (path === "/api/import-url" && method === "POST") {
			const body = await this.readBody(req);
			try {
				return this.json(res, 200, await h.importUrl(String(body.url ?? "")));
			} catch (err) {
				return this.json(res, 400, { error: String((err as Error).message ?? err) });
			}
		}
		if (path === "/api/abort" && method === "POST") {
			await h.abort();
			return this.json(res, 200, { ok: true });
		}
		return this.json(res, 404, { error: "not found" });
	}
}
