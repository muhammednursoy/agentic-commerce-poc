import http from "node:http";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { providerLabel, startBackends } from "../backends.ts";
import { createAgent, createToolset } from "../agent/factory.ts";
import type { ChatAgent } from "../agent/llm/types.ts";
import type { CheckoutSummary, Toolset } from "../agent/toolset.ts";

const PORT = Number(process.env.WEB_PORT || 8090);
const PAGE = readFileSync(new URL("./index.html", import.meta.url), "utf8");

type Event = Record<string, unknown> & { type: string };

interface Session {
  agent: ChatAgent;
  clients: Set<http.ServerResponse>;
  backlog: Event[];
  busy: boolean;
  approval?: { id: string; resolve: (ok: boolean) => void };
}

const sessions = new Map<string, Session>();

function emit(session: Session, event: Event): void {
  session.backlog.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of session.clients) client.write(line);
}

function isCheckout(value: unknown): value is CheckoutSummary {
  return typeof value === "object" && value !== null && "line_items" in value && "totals" in value;
}

async function orderPayment(orderId: string) {
  try {
    const res = await fetch(`${config.merchantUrl}/orders/${orderId}`);
    const order = await res.json();
    const psp: string | undefined = order.pspReference;
    const dashboard = order.provider === "stripe" && psp?.startsWith("pi_") && config.stripe.mode === "test"
      ? `https://dashboard.stripe.com/test/payments/${psp}`
      : undefined;
    return { provider: order.provider, pspReference: psp, dashboard, verifiableIntent: order.verifiableIntent };
  } catch {
    return {};
  }
}

function observed(session: Session, base: Toolset): Toolset {
  return {
    protocol: base.protocol,
    definitions: base.definitions,
    system: base.system,
    names: base.names,
    async execute(name, input) {
      emit(session, { type: "tool", name, input });
      const output = await base.execute(name, input);
      if (isCheckout(output)) {
        emit(session, { type: "checkout", checkout: output });
        if (output.order) emit(session, { type: "order", order: output.order, total: output.totals.total, currency: output.currency, payment: await orderPayment(output.order.id) });
      } else if (output && typeof output === "object" && "error" in output) {
        emit(session, { type: "tool_error", name, error: (output as { error: string }).error });
      }
      return output;
    },
  };
}

function session(sid: string): Session {
  let s = sessions.get(sid);
  if (s) return s;
  const fresh: Session = { agent: undefined as unknown as ChatAgent, clients: new Set(), backlog: [], busy: false };
  const toolset = createToolset((summary) => new Promise<boolean>((resolve) => {
    const id = randomUUID();
    fresh.approval = { id, resolve };
    emit(fresh, { type: "approval", id, summary });
  }));
  fresh.agent = createAgent({ toolset: observed(fresh, toolset) });
  sessions.set(sid, fresh);
  return fresh;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const sid = url.searchParams.get("sid") ?? "";

  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return void res.end(PAGE);
  }
  if (req.method === "GET" && url.pathname === "/api/info") {
    const probe = session(sid || "info");
    return json(res, 200, { agent: probe.agent.label, protocol: config.protocol, provider: providerLabel() });
  }
  if (req.method === "GET" && url.pathname === "/api/products") {
    const r = await fetch(`${config.merchantUrl}/products`);
    return json(res, r.status, await r.json());
  }
  if (!/^[\w-]{8,64}$/.test(sid)) return json(res, 400, { error: "sid required" });
  const s = session(sid);

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    for (const event of s.backlog) res.write(`data: ${JSON.stringify(event)}\n\n`);
    s.clients.add(res);
    req.on("close", () => s.clients.delete(res));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/message") {
    const { text } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text required" });
    if (s.busy) return json(res, 409, { error: "agent is still working" });
    s.busy = true;
    emit(s, { type: "user", text });
    emit(s, { type: "thinking" });
    json(res, 202, { ok: true });
    try {
      emit(s, { type: "reply", text: await s.agent.send(text) });
    } catch (err) {
      emit(s, { type: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      s.busy = false;
      emit(s, { type: "idle" });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/approval") {
    const { id, approved } = await readJson(req);
    if (!s.approval || s.approval.id !== id) return json(res, 409, { error: "no pending approval" });
    const { resolve } = s.approval;
    s.approval = undefined;
    emit(s, { type: "approval_result", id, approved: approved === true });
    resolve(approved === true);
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/api/reset") {
    if (s.busy) return json(res, 409, { error: "agent is still working" });
    for (const client of s.clients) client.end();
    sessions.delete(sid);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
}

await startBackends();
http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, 500, { error: String(err) });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`AI shopping UI: http://localhost:${PORT}  (${providerLabel()})`);
});
