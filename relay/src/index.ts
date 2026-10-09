// CellDesk relay: lets a phone reach a PC on any network.
//
// The PC keeps one outbound WebSocket open to its room (a Durable Object);
// phones POST end-to-end encrypted uploads to the same room, which streams
// them down that socket and replies with the PC's acknowledgement. Nothing is
// stored and the relay never holds the decryption key.
import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

// /pc/<room> PC socket · /u/<room> phone upload · /s/<room> status
// /l/<room> outbox list · /d/<room>/<file id> outbox download
const ROUTE = /^\/(pc|u|s|l|d)\/([A-Za-z0-9_-]{16,64})(?:\/([0-9a-f]{16}))?$/;
const DOWNLOAD_START_MS = 30_000;
const MAX_UPLOAD = 100 * 1024 * 1024;
const WS_CHUNK = 256 * 1024;
const ACK_TIMEOUT_MS = 120_000;

type Ack = { ok: boolean; error?: string; [k: string]: unknown };
type Attachment = { name?: string; outbox?: string };
type Download = {
  id: string;
  writer: WritableStreamDefaultWriter<Uint8Array>;
  start: (r: { ok: boolean; error?: string }) => void;
  done: () => void;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env): Promise<Response> {
    const m = ROUTE.exec(new URL(request.url).pathname);
    // Only downloads carry a file id.
    if (!m || (m[1] === "d") !== !!m[3]) return env.ASSETS.fetch(request);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[2]));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class Room extends DurableObject<Env> {
  private pending = new Map<string, (ack: Ack) => void>();
  private chain: Promise<unknown> = Promise.resolve();
  private dl: Download | null = null;
  private dlChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answer keep-alives without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const [, kind, , file] = new URL(request.url).pathname.split("/");
    if (kind === "pc") return this.attachPC(request);
    if (kind === "s") {
      const pc = this.pc();
      const att = pc?.deserializeAttachment() as Attachment | null;
      return json({ online: !!pc, name: att?.name ?? null, outbox: att?.outbox ?? null });
    }
    if (kind === "u") {
      if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
      return this.enqueue(request);
    }
    if (kind === "l" || kind === "d") return this.enqueueDownload(kind === "l" ? "list" : "get", file);
    return new Response("not found", { status: 404 });
  }

  private pc(): WebSocket | undefined {
    const open = this.ctx.getWebSockets("pc").filter((ws) => ws.readyState === WebSocket.OPEN);
    return open[open.length - 1];
  }

  private async attachPC(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const auth = request.headers.get("Authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (key.length < 32) return new Response("missing key", { status: 401 });

    // The first PC to claim a room owns it; its key is stored as a hash.
    const hash = await sha256hex(key);
    const stored = await this.ctx.storage.get<string>("pcKeyHash");
    if (!stored) await this.ctx.storage.put("pcKeyHash", hash);
    else if (stored !== hash) return new Response("wrong key", { status: 403 });

    for (const old of this.ctx.getWebSockets("pc")) {
      try { old.close(4000, "replaced by a newer connection"); } catch { /* already closed */ }
    }
    const name = (new URL(request.url).searchParams.get("name") ?? "").slice(0, 64);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["pc"]);
    pair[1].serializeAttachment({ name });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private enqueue(request: Request): Promise<Response> {
    const len = Number(request.headers.get("Content-Length") ?? "0");
    if (len > MAX_UPLOAD) return Promise.resolve(json({ ok: false, error: "too_large" }, 413));
    if (!this.pc()) return Promise.resolve(json({ ok: false, error: "pc_offline" }, 503));
    // One upload at a time per PC keeps the stream on the socket simple.
    const run = this.chain.then(() => this.pipe(request));
    this.chain = run.catch(() => {});
    return run;
  }

  private async pipe(request: Request): Promise<Response> {
    const ws = this.pc();
    if (!ws || !request.body) return json({ ok: false, error: "pc_offline" }, 503);

    const id = crypto.randomUUID();
    const ack = new Promise<Ack>((resolve) => {
      const timer = setTimeout(() => settle({ ok: false, error: "timeout" }), ACK_TIMEOUT_MS);
      const settle = (a: Ack) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(a);
      };
      this.pending.set(id, settle);
    });

    try {
      ws.send(JSON.stringify({ t: "begin", id }));
      const reader = request.body.getReader();
      let buf = new Uint8Array(WS_CHUNK);
      let fill = 0;
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_UPLOAD) throw new Error("too_large");
        let off = 0;
        while (off < value.length) {
          const n = Math.min(WS_CHUNK - fill, value.length - off);
          buf.set(value.subarray(off, off + n), fill);
          fill += n;
          off += n;
          if (fill === WS_CHUNK) {
            ws.send(buf);
            buf = new Uint8Array(WS_CHUNK);
            fill = 0;
          }
        }
      }
      if (fill > 0) ws.send(buf.slice(0, fill));
      ws.send(JSON.stringify({ t: "end", id }));
    } catch (e) {
      try { ws.send(JSON.stringify({ t: "abort", id })); } catch { /* socket gone */ }
      this.pending.get(id)?.({ ok: false, error: e instanceof Error && e.message === "too_large" ? "too_large" : "upload_interrupted" });
    }

    const result = await ack;
    // 5xx tells the phone to keep the photo queued and retry later.
    const retryable = ["pc_offline", "pc_disconnected", "timeout", "upload_interrupted"].includes(result.error ?? "");
    return json(result, result.ok ? 200 : retryable ? 503 : 422);
  }

  // Downloads (phone asks for the PC's outbox) run one at a time: the PC's
  // binary messages then always belong to the current one.
  private enqueueDownload(kind: "list" | "get", file?: string): Promise<Response> {
    if (!this.pc()) return Promise.resolve(json({ ok: false, error: "pc_offline" }, 503));
    let release!: () => void;
    const finished = new Promise<void>((r) => { release = r; });
    const run = this.dlChain.then(() => this.download(kind, file, release));
    this.dlChain = run.then(() => finished, () => release()).catch(() => {});
    return run;
  }

  private async download(kind: "list" | "get", file: string | undefined, release: () => void): Promise<Response> {
    const ws = this.pc();
    if (!ws) {
      release();
      return json({ ok: false, error: "pc_offline" }, 503);
    }
    const id = crypto.randomUUID();
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const started = new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: "timeout" }), DOWNLOAD_START_MS);
      this.dl = {
        id,
        writer: writable.getWriter(),
        start: (r) => { clearTimeout(timer); resolve(r); },
        done: release,
      };
    });
    ws.send(JSON.stringify({ t: kind, id, file }));
    const r = await started;
    if (!r.ok) {
      this.finishDownload(id, false);
      return json({ ok: false, error: r.error }, r.error === "not_found" ? 404 : 503);
    }
    return new Response(readable, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  }

  private finishDownload(id: string, ok: boolean): void {
    const d = this.dl;
    if (!d || d.id !== id) return;
    this.dl = null;
    d.start({ ok: false, error: "pc_disconnected" }); // no-op once started
    (ok ? d.writer.close() : d.writer.abort("download failed")).catch(() => {});
    d.done();
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      this.dl?.writer.write(new Uint8Array(message)).catch(() => {});
      return;
    }
    let m: { t?: string; id?: string; ok?: boolean; error?: string; v?: string };
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === "ack" && typeof m.id === "string") this.pending.get(m.id)?.(m as Ack);
    else if (m.t === "rbegin" && this.dl && this.dl.id === m.id) this.dl.start({ ok: !!m.ok, error: m.error });
    else if (m.t === "rend" && typeof m.id === "string") this.finishDownload(m.id, m.ok !== false);
    else if (m.t === "outbox" && typeof m.v === "string") {
      const att = (ws.deserializeAttachment() as Attachment | null) ?? {};
      ws.serializeAttachment({ ...att, outbox: m.v.slice(0, 64) });
    }
  }

  private failAll(): void {
    for (const settle of [...this.pending.values()]) settle({ ok: false, error: "pc_disconnected" });
    if (this.dl) this.finishDownload(this.dl.id, false);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.failAll();
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, reason); } catch { /* already closed */ }
  }

  async webSocketError(): Promise<void> {
    this.failAll();
  }
}
