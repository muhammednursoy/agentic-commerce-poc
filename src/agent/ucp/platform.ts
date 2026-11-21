import { randomUUID } from "node:crypto";
import { config } from "../../config.ts";
import { callJson } from "../../http.ts";
import type { CallResult } from "../../http.ts";
import { GOOGLE_PAY_HANDLER, SHOPPING_SERVICE } from "../../ucp.ts";
import type { GooglePayHandler, PaymentInstrument, PostalAddress, UcpCheckout, UcpLineItemInput, UcpProfile } from "../../ucp.ts";
import type { Product } from "../../merchant/server.ts";
import { defaultShopper } from "../shopper.ts";
import type { ShopperProfile } from "../shopper.ts";

export class UcpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(operation: string, result: CallResult) {
    super(`${operation} failed with HTTP ${result.status}: ${JSON.stringify(result.body)}`);
    this.status = result.status;
    this.body = result.body;
  }
}

export interface MerchantInfo {
  endpoint: string;
  capabilities: string[];
  googlePay?: GooglePayHandler;
}

export class UcpPlatform {
  readonly shopper: ShopperProfile;
  readonly agentProfileUrl: string;
  private readonly merchantUrl: string;
  private merchant?: MerchantInfo;

  constructor(shopper: ShopperProfile = defaultShopper(), merchantUrl = config.merchantUrl, agentProfileUrl = "https://agent.example/.well-known/ucp") {
    this.shopper = shopper;
    this.merchantUrl = merchantUrl;
    this.agentProfileUrl = agentProfileUrl;
  }

  async discover(): Promise<MerchantInfo> {
    if (this.merchant) return this.merchant;
    const res = await callJson("GET", `${this.merchantUrl}/.well-known/ucp`, { label: "agent→merchant ucp" });
    if (res.status !== 200) throw new UcpError("discover", res);
    const profile = res.body as UcpProfile;
    const service = profile.ucp.services[SHOPPING_SERVICE]?.find((s) => s.transport === "rest");
    if (!service) throw new Error("merchant does not offer the dev.ucp.shopping REST service");
    this.merchant = {
      endpoint: service.endpoint,
      capabilities: Object.keys(profile.ucp.capabilities),
      googlePay: profile.ucp.payment_handlers[GOOGLE_PAY_HANDLER]?.[0],
    };
    return this.merchant;
  }

  async listProducts(): Promise<Product[]> {
    const res = await callJson("GET", `${this.merchantUrl}/products`, { label: "agent→merchant feed" });
    return res.body.products;
  }

  async create(items: { id: string; quantity: number }[]): Promise<UcpCheckout> {
    return this.call("POST", "", "create_checkout", {
      line_items: toLineItems(items),
      currency: "USD",
      buyer: this.buyer(),
      fulfillment: { methods: [{ type: "shipping", destinations: [this.destination()] }] },
    });
  }

  get(id: string): Promise<UcpCheckout> {
    return this.call("GET", `/${id}`, "get_checkout");
  }

  async update(id: string, change: { items?: { id: string; quantity: number }[]; fulfillmentOptionId?: string }): Promise<UcpCheckout> {
    const current = await this.get(id);
    const method = current.fulfillment?.methods[0];
    const optionId = change.fulfillmentOptionId ?? method?.groups?.[0]?.selected_option_id;
    return this.call("PUT", `/${id}`, "update_checkout", {
      id,
      currency: current.currency,
      line_items: change.items ? toLineItems(change.items) : current.line_items.map((li) => ({ item: { id: li.item.id }, quantity: li.quantity })),
      buyer: current.buyer ?? this.buyer(),
      fulfillment: {
        methods: [{
          type: "shipping",
          destinations: method?.destinations?.length ? method.destinations : [this.destination()],
          selected_destination_id: method?.selected_destination_id ?? "dest_1",
          ...(optionId ? { groups: [{ selected_option_id: optionId }] } : {}),
        }],
      },
    });
  }

  complete(id: string, instrument: PaymentInstrument): Promise<UcpCheckout> {
    return this.call("POST", `/${id}/complete`, "complete_checkout", { payment: { instruments: [instrument] } }, randomUUID());
  }

  cancel(id: string): Promise<UcpCheckout> {
    return this.call("POST", `/${id}/cancel`, "cancel_checkout", {}, randomUUID());
  }

  private buyer() {
    return { first_name: this.shopper.buyer.first_name, last_name: this.shopper.buyer.last_name, email: this.shopper.buyer.email };
  }

  private destination(): PostalAddress {
    const a = this.shopper.address;
    const [first_name, ...rest] = (a.name ?? "").split(" ");
    return {
      id: "dest_1",
      first_name,
      last_name: rest.join(" "),
      street_address: a.line_one,
      address_locality: a.city,
      address_region: a.state,
      postal_code: a.postal_code,
      address_country: a.country,
    };
  }

  private async call(method: string, suffix: string, operation: string, body?: unknown, idempotencyKey?: string): Promise<UcpCheckout> {
    const { endpoint } = await this.discover();
    const res = await callJson(method, `${endpoint}/checkout-sessions${suffix}`, {
      label: "agent→merchant ucp",
      headers: {
        "ucp-agent": `profile="${this.agentProfileUrl}"`,
        "request-id": randomUUID(),
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body,
    });
    if (res.status !== 200 && res.status !== 201) throw new UcpError(operation, res);
    return res.body;
  }
}

function toLineItems(items: { id: string; quantity: number }[]): UcpLineItemInput[] {
  return items.map((i) => ({ item: { id: i.id }, quantity: i.quantity }));
}
