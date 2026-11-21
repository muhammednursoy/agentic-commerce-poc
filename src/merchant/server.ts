import type http from "node:http";
import { config, tracing } from "../config.ts";
import { Router } from "../http.ts";
import type { Req, Res } from "../http.ts";
import { isValidNotification } from "../adyen-hmac.ts";
import type { NotificationRequestItem } from "../adyen-hmac.ts";
import type { Product } from "../domain.ts";
import { registerAcpHooks } from "./acp-hooks.ts";
import { AcpMerchant } from "./acp-server.ts";
import { requestRefund } from "./adyen-checkout.ts";
import { refundPaymentIntent } from "./stripe-payments.ts";
import { MerchantStore } from "./store.ts";
import { UcpMerchant } from "./ucp-server.ts";

const TERMS = "Brew & Co terms of sale (POC). Orders placed by an AI agent on your behalf are binding once you approve the total in Google Pay or your agent platform.";
const REFUNDS = "Brew & Co refund policy (POC). Unopened items can be returned within 30 days for a full refund to the original payment method.";

export class Merchant {
  readonly store: MerchantStore;
  readonly ucp: UcpMerchant;
  readonly acp: AcpMerchant;
  readonly webhooks: NotificationRequestItem[] = [];

  constructor(products?: Product[]) {
    this.store = new MerchantStore(products);
    this.ucp = new UcpMerchant(this.store);
    this.acp = new AcpMerchant(this.store);
  }

  get catalog() {
    return this.store.catalog;
  }

  get orders() {
    return this.store.orders;
  }

  router(): Router {
    const router = new Router()
      .on("GET", "/products", () => ({ status: 200, body: { products: [...this.store.catalog.values()] } }))
      .on("GET", "/orders/:id", (r) => {
        const order = this.store.orders.get(r.params.id);
        return order ? { status: 200, body: order } : { status: 404, body: { message: "order not found" } };
      })
      .on("POST", "/orders/:id/refund", (r) => this.refund(r.params.id))
      .on("GET", "/terms", () => ({ status: 200, body: TERMS }))
      .on("GET", "/refunds", () => ({ status: 200, body: REFUNDS }))
      .on("POST", "/adyen/webhooks", (r) => this.webhook(r));
    registerAcpHooks(router, this.store);
    this.ucp.register(router);
    this.acp.register(router);
    return router;
  }

  listen(port: number): Promise<http.Server> {
    return this.router().listen(port, "merchant");
  }

  private async refund(id: string): Promise<Res> {
    const order = this.store.orders.get(id);
    if (!order) return { status: 404, body: { message: "order not found" } };
    if (order.refund) return { status: 409, body: { message: `a refund for this order is already ${order.refund.status}`, refund: order.refund } };
    if (order.provider === "stripe") {
      const refund = await refundPaymentIntent(order.pspReference, order.amount, `${order.id}-refund`);
      if (!refund.id) return { status: 502, body: { message: `Stripe did not accept the refund: ${refund.failure}` } };
      const status = refund.status === "succeeded" ? "refunded" : refund.status === "failed" || refund.status === "canceled" ? "failed" : "received";
      order.refund ??= { pspReference: refund.id, amount: order.amount, status };
      return { status: status === "received" ? 202 : 200, body: order.refund };
    }
    const result = await requestRefund(order.pspReference, { value: order.amount, currency: order.currency }, order.id);
    if (!result.pspReference) return { status: 502, body: { message: `Adyen did not accept the refund: ${result.failure}` } };
    order.refund ??= { pspReference: result.pspReference, amount: order.amount, status: "received" };
    return { status: 202, body: order.refund };
  }

  private webhook(req: Req): Res {
    const items: NotificationRequestItem[] = (req.body?.notificationItems ?? []).map((n: { NotificationRequestItem: NotificationRequestItem }) => n.NotificationRequestItem);
    if (!config.webhookHmacKey && !config.webhookInsecure) {
      return { status: 401, body: { message: "ADYEN_HMAC_KEY is not configured; webhooks are rejected" } };
    }
    for (const item of items) {
      if (config.webhookHmacKey && !isValidNotification(item, config.webhookHmacKey)) {
        return { status: 401, body: { message: "invalid HMAC signature" } };
      }
    }
    for (const item of items) {
      this.webhooks.push(item);
      const success = item.success === "true";
      if (item.eventCode === "AUTHORISATION" && !this.store.orderByPspReference(item.pspReference)) {
        const settled = this.ucp.settleByReference(item.merchantReference, item.amount, {
          resultCode: success ? "Authorised" : "Refused",
          pspReference: item.pspReference,
          refusalReason: item.reason || undefined,
        });
        if (!settled && tracing()) console.log(`  webhook ${item.pspReference}: no pending UCP payment ${item.merchantReference} for ${item.amount?.value} ${item.amount?.currency}; not settled`);
      }
      const isRefund = item.eventCode === "REFUND";
      const order = this.store.orderByPspReference(isRefund ? item.originalReference ?? "" : item.pspReference);
      if (!order) continue;
      if (isRefund && (!order.refund || order.refund.pspReference === item.pspReference)) {
        order.refund = { pspReference: item.pspReference, amount: item.amount.value, status: success ? "refunded" : "failed" };
      }
      const event = `${item.eventCode}:${item.success}`;
      if (!order.webhookEvents.includes(event)) order.webhookEvents.push(event);
    }
    return { status: 200, body: "[accepted]" };
  }
}
