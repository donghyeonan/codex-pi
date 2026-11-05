/**
 * Minimal WebSocket client over any byte stream (a unix socket, or the stdio of `codex app-server proxy`).
 * Codex's app-server daemon speaks JSON-RPC over WebSocket on its control socket; this is all we need of RFC 6455:
 * text frames, masking, fragmentation, ping/pong and close.
 */
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Duplex, Readable, Writable } from "node:stream";

export interface ByteStream {
	readable: Readable;
	writable: Writable;
	destroy(): void;
}

export function streamOf(d: Duplex): ByteStream {
	return { readable: d, writable: d, destroy: () => d.destroy() };
}

export class MiniWebSocket extends EventEmitter {
	private s: ByteStream;
	private buf = Buffer.alloc(0);
	private open = false;
	private frag: Buffer[] = [];
	closed = false;

	constructor(s: ByteStream) {
		super();
		this.s = s;
	}

	/** Send the HTTP upgrade and resolve once the server switched protocols. */
	connect(host = "localhost", path = "/"): Promise<void> {
		const key = randomBytes(16).toString("base64");
		return new Promise((resolve, reject) => {
			const fail = (e: Error) => {
				if (!this.open) reject(e);
				this.shut(e);
			};
			this.s.readable.on("error", fail);
			this.s.writable.on("error", fail);
			this.s.readable.on("close", () => this.shut());
			this.s.readable.on("end", () => this.shut());
			this.s.readable.on("data", (chunk: Buffer) => {
				this.buf = Buffer.concat([this.buf, chunk]);
				if (!this.open) {
					const end = this.buf.indexOf("\r\n\r\n");
					if (end < 0) return;
					const head = this.buf.subarray(0, end).toString("latin1");
					this.buf = this.buf.subarray(end + 4);
					if (!/^HTTP\/1\.1 101/.test(head)) return fail(new Error(`websocket upgrade refused: ${head.split("\r\n")[0]}`));
					this.open = true;
					resolve();
				}
				this.drain();
			});
			this.s.writable.write(
				`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
			);
		});
	}

	send(text: string) {
		if (this.closed) throw new Error("websocket closed");
		this.frame(0x1, Buffer.from(text, "utf8"));
	}

	close() {
		if (!this.closed) {
			try {
				this.frame(0x8, Buffer.alloc(0));
			} catch {}
		}
		this.shut();
	}

	private shut(err?: Error) {
		if (this.closed) return;
		this.closed = true;
		this.s.destroy();
		this.emit("close", err);
	}

	private frame(op: number, payload: Buffer) {
		const len = payload.length;
		const head = len < 126 ? Buffer.alloc(2) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
		head[0] = 0x80 | op;
		if (len < 126) head[1] = 0x80 | len;
		else if (len < 65536) {
			head[1] = 0x80 | 126;
			head.writeUInt16BE(len, 2);
		} else {
			head[1] = 0x80 | 127;
			head.writeBigUInt64BE(BigInt(len), 2);
		}
		const mask = randomBytes(4);
		const body = Buffer.alloc(len);
		for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
		this.s.writable.write(Buffer.concat([head, mask, body]));
	}

	private drain() {
		for (;;) {
			if (this.buf.length < 2) return;
			const b0 = this.buf[0];
			const b1 = this.buf[1];
			let len = b1 & 0x7f;
			let off = 2;
			if (len === 126) {
				if (this.buf.length < 4) return;
				len = this.buf.readUInt16BE(2);
				off = 4;
			} else if (len === 127) {
				if (this.buf.length < 10) return;
				len = Number(this.buf.readBigUInt64BE(2));
				off = 10;
			}
			const masked = (b1 & 0x80) !== 0;
			const maskKey = masked ? this.buf.subarray(off, off + 4) : undefined;
			if (masked) off += 4;
			if (this.buf.length < off + len) return;
			let payload = Buffer.from(this.buf.subarray(off, off + len));
			if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
			this.buf = this.buf.subarray(off + len);
			const op = b0 & 0x0f;
			const fin = (b0 & 0x80) !== 0;
			if (op === 0x8) return this.shut();
			if (op === 0x9) {
				this.frame(0xa, payload);
				continue;
			}
			if (op === 0xa) continue;
			if (op === 0x0 || op === 0x1 || op === 0x2) {
				this.frag.push(payload);
				if (!fin) continue;
				payload = Buffer.concat(this.frag);
				this.frag = [];
				this.emit("message", payload.toString("utf8"));
			}
		}
	}
}
