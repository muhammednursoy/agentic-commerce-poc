import http from "node:http";
import { randomBytes } from "node:crypto";
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
        const body = raw ? JSON.parse(raw) : undefined;
        out = await this.dispatch(req.method ?? "GET", url.pathname, req.headers, body);
      } catch (err) {
        out = err instanceof SyntaxError
          ? { status: 400, body: { type: "invalid_request", code: "invalid_json", message: err.message } }
          : { status: 500, body: { type: "processing_error", message: String(err) } };
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
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

const SENSITIVE = /("(number|cvc|cryptogram)":\s*")([^"]+)(")/g;

export function redact(text: string): string {
  return text.replace(SENSITIVE, (_, open: string, key: string, value: string, close: string) =>
    key === "number" ? `${open}${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}${close}` : `${open}***${close}`);
}

export async function callJson(
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: Json; label?: string } = {},
): Promise<CallResult> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  if (tracing()) {
    console.log(`  \x1b[2m${options.label ?? "http"} →${method} ${url}${payload ? `\n    ${redact(payload)}` : ""}\x1b[0m`);
  }
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...options.headers },
    body: payload,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (tracing()) {
    console.log(`  \x1b[2m${options.label ?? "http"} ←${response.status} ${text.length > 600 ? `${text.slice(0, 600)}…` : text}\x1b[0m`);
  }
  return { status: response.status, body };
}

export function randomId(prefix: string, bytes = 8): string {
  return `${prefix}${randomBytes(bytes).toString("hex")}`;
}

export function pspReference(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}
