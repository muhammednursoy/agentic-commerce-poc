import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { tracing } from "./config.ts";

export type Json = any;

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  headers: http.IncomingHttpHeaders;
  body: Json;
}

export interface Res {
  status: number;
  body?: Json;
}

export type Handler = (req: Req) => Res | Promise<Res>;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern.replace(/:(\w+)/g, (_, key: string) => {
      keys.push(key);
      return "([^/]+)";
    });
    this.routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler });
    return this;
  }

  listen(port: number, name: string): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      let out: Res;
      try {
        const form = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");
        const body = !raw ? undefined : form ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw);
        out = await this.dispatch(req.method ?? "GET", url.pathname, req.headers, body);
      } catch (err) {
        out = err instanceof SyntaxError
          ? { status: 400, body: { type: "invalid_request", code: "invalid_json", message: err.message } }
          : { status: 500, body: { type: "processing_error", message: String(err) } };
      }
      const text = typeof out.body === "string";
      res.writeHead(out.status, { "content-type": text ? "text/plain" : "application/json" });
      res.end(out.body === undefined ? "" : text ? out.body : JSON.stringify(out.body));
    });
    return new Promise((resolve) => server.listen(port, () => {
      if (tracing()) console.log(`[${name}] listening on http://localhost:${port}`);
      resolve(server);
    }));
  }

  private async dispatch(method: string, path: string, headers: http.IncomingHttpHeaders, body: Json): Promise<Res> {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (!match) continue;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      return route.handler({ method, path, params, headers, body });
    }
    return { status: 404, body: { type: "invalid_request", code: "not_found", message: `${method} ${path}` } };
  }
}

export interface CallResult {
  status: number;
  body: Json;
}

const SENSITIVE = /("(number|cvc|cryptogram|googlePayToken|token|storedPaymentMethodId|recurringDetailReference|exp_month|exp_year|name|client_secret)":\s*")((?:[^"\\]|\\.)*)(")/g;

const SHARED_PAYMENT_TOKEN = /\bspt_[A-Za-z0-9]+/g;

export function redact(text: string): string {
  return text
    .replace(SENSITIVE, (_, open: string, key: string, value: string, close: string) =>
      key === "number" ? `${open}${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}${close}` : `${open}***${close}`)
    .replace(SHARED_PAYMENT_TOKEN, "spt_***");
}

export async function callJson(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: Json; form?: Record<string, string>; label?: string; signal?: AbortSignal } = {},
): Promise<CallResult> {
  const json = options.body === undefined ? undefined : JSON.stringify(options.body);
  const payload = options.form ? new URLSearchParams(options.form).toString() : json;
  if (tracing()) {
    const shown = options.form ? JSON.stringify(options.form) : json;
    console.log(`  \x1b[2m${options.label ?? "http"} →${method} ${url}${shown ? `\n    ${redact(shown)}` : ""}\x1b[0m`);
  }
  const response = await fetch(url, {
    method,
    headers: { "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json", ...options.headers },
    body: payload,
    signal: options.signal,
  });
  const text = await response.text();
  const body = response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : text || undefined;
  if (tracing()) {
    const shown = redact(text);
    console.log(`  \x1b[2m${options.label ?? "http"} ←${response.status} ${shown.length > 600 ? `${shown.slice(0, 600)}…` : shown}\x1b[0m`);
  }
  return { status: response.status, body };
}

export class IdempotencyCache {
  private readonly seen = new Map<string, { hash: string; res: Res }>();

  async run(req: Req, next: () => Res | Promise<Res>, conflict: () => Res, keep: (res: Res) => boolean): Promise<Res> {
    const key = req.headers["idempotency-key"];
    if (req.method === "GET" || typeof key !== "string") return next();
    const scope = `${req.method} ${req.path} ${key}`;
    const hash = createHash("sha256").update(JSON.stringify(req.body ?? {})).digest("hex");
    const seen = this.seen.get(scope);
    if (seen) return seen.hash === hash ? seen.res : conflict();
    const res = await next();
    if (keep(res)) this.seen.set(scope, { hash, res });
    return res;
  }
}

export function randomId(prefix: string, bytes = 8): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

export function pspReference(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}
