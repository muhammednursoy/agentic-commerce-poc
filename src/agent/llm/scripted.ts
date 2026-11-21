import { formatAmount } from "../../acp.ts";
import type { Item } from "../../acp.ts";
import type { Product } from "../../merchant/server.ts";
import type { summarize } from "../tools.ts";
import type { AgentOptions, ChatAgent } from "./types.ts";

type Summary = ReturnType<typeof summarize>;

export class ScriptedAgent implements ChatAgent {
  readonly label = "scripted (no LLM)";
  private readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  async send(userText: string): Promise<string> {
    const { products } = await this.call<{ products: Product[] }>("list_products", {});
    const items = pickItems(userText, products);
    if (items.length === 0) {
      return `I could not match your request to a product. Available: ${products.map((p) => p.title).join(", ")}.`;
    }
    let session = await this.call<Summary>("create_checkout_session", { items });
    const blocking = session.messages.filter((m) => m.type === "error");
    if (blocking.length) return `The merchant rejected the cart: ${blocking.map((m) => m.content).join("; ")}`;

    const cheapest = [...session.fulfillment_options].sort((a, b) => a.total - b.total)[0];
    session = await this.call<Summary>("update_checkout_session", { session_id: session.id, fulfillment_option_id: cheapest.id });
    if (session.status !== "ready_for_payment") return `Session is ${session.status}: ${JSON.stringify(session.messages)}`;

    const done = await this.call<Summary & { declined_by_shopper?: boolean; error?: string }>("pay_and_complete", { session_id: session.id });
    if (done.declined_by_shopper) return "Okay, I did not place the order.";
    if (done.error) return `Payment step failed: ${done.error}`;
    if (done.status !== "completed" || !done.order) return `The order was not completed: ${done.messages.map((m) => m.content).join("; ")}`;
    return `Order ${done.order.id} placed for ${formatAmount(done.totals.total, done.currency)}. Details: ${done.order.permalink_url}`;
  }

  private async call<T>(name: string, input: Record<string, unknown>): Promise<T> {
    this.options.onToolCall?.(name, input);
    return (await this.options.tools.execute(name, input)) as T;
  }
}

const STOP_WORDS = new Set(["and", "the", "with", "for", "pcs", "size"]);

export function pickItems(text: string, products: Product[]): Item[] {
  const lower = text.toLowerCase();
  const items: Item[] = [];
  for (const p of products) {
    const words = p.title.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? [];
    const hits = words.filter((w) => lower.includes(w.replace(/s$/, "")));
    if (hits.length < Math.min(2, words.length)) continue;
    let quantity = 1;
    for (const w of hits) {
      const m = new RegExp(`(\\d+)\\s*(?:x\\s*)?(?:[a-z-]+\\s+){0,3}${w.replace(/s$/, "")}`).exec(lower);
      if (m) {
        quantity = Number(m[1]);
        break;
      }
    }
    items.push({ id: p.id, quantity });
  }
  return items;
}
