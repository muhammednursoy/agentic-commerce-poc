import { formatAmount } from "../../acp.ts";
import type { Item } from "../../acp.ts";
import type { Product } from "../../merchant/server.ts";
import type { CheckoutSummary } from "../toolset.ts";
import type { AgentOptions, ChatAgent } from "./types.ts";

type PayResult = CheckoutSummary & { declined_by_shopper?: boolean; error?: string };

export class ScriptedAgent implements ChatAgent {
  readonly label = "scripted (no LLM)";
  private readonly options: AgentOptions;

  constructor(options: AgentOptions) {
    this.options = options;
  }

  async send(userText: string): Promise<string> {
    const { names } = this.options.toolset;
    const listed = await this.call<{ products: Product[]; error?: string }>(names.list, {});
    if (listed.error) return `Could not read the product feed: ${listed.error}`;
    const items = pickItems(userText, listed.products);
    if (items.length === 0) {
      return `I could not match your request to a product. Available: ${listed.products.map((p) => p.title).join(", ")}.`;
    }
    let checkout = await this.call<PayResult>(names.create, { items });
    if (checkout.error) return `Could not create the checkout: ${checkout.error}`;
    const blocking = checkout.messages.filter((m) => m.type === "error" && m.code !== "missing" && m.code !== "missing_fulfillment_option");
    if (blocking.length) return `The merchant rejected the cart: ${blocking.map((m) => m.content).join("; ")}`;

    const cheapest = [...checkout.fulfillment_options].sort((a, b) => a.total - b.total)[0];
    if (!cheapest) return `The merchant offered no shipping option: ${JSON.stringify(checkout.messages)}`;
    const idField = this.options.toolset.protocol === "ucp" ? "checkout_id" : "session_id";
    checkout = await this.call<PayResult>(names.update, { [idField]: checkout.id, fulfillment_option_id: cheapest.id });
    if (checkout.error) return `Could not update the checkout: ${checkout.error}`;
    if (!checkout.ready) return `Checkout is ${checkout.status}: ${JSON.stringify(checkout.messages)}`;

    const done = await this.call<PayResult>(names.pay, { [idField]: checkout.id });
    if (done.declined_by_shopper) return "Okay, I did not place the order.";
    if (done.error) return `Payment step failed: ${done.error}`;
    if (done.status === "requires_escalation") return `The merchant needs you to finish on their site: ${done.continue_url}`;
    if (done.status !== "completed" || !done.order) return `The order was not completed: ${done.messages.map((m) => m.content).join("; ")}`;
    return `Order ${done.order.id} placed for ${formatAmount(done.totals.total, done.currency)}. Details: ${done.order.permalink_url}`;
  }

  private async call<T>(name: string, input: Record<string, unknown>): Promise<T> {
    this.options.onToolCall?.(name, input);
    return (await this.options.toolset.execute(name, input)) as T;
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
