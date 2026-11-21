import type http from "node:http";
import { config } from "../config.ts";
import { Router } from "../http.ts";
import type { Req, Res } from "../http.ts";
import { isValidNotification } from "../adyen-hmac.ts";
import type { NotificationRequestItem } from "../adyen-hmac.ts";
import { registerAcpHooks } from "./acp-hooks.ts";
import { MerchantStore } from "./store.ts";
import type { Product } from "./store.ts";
import { UcpMerchant } from "./ucp-server.ts";

export type { MerchantOrder, Product } from "./store.ts";

export class Merchant {
  readonly store: MerchantStore;
  readonly ucp: UcpMerchant;
  readonly webhooks: NotificationRequestItem[] = [];

  constructor(products?: Product[]) {
    this.store = new MerchantStore(products);
    this.ucp = new UcpMerchant(this.store);
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
      .on("POST", "/adyen/webhooks", (r) => this.webhook(r));
    registerAcpHooks(router, this.store);
    this.ucp.register(router);
    return router;
  }

  listen(port: number): Promise<http.Server> {
    return this.router().listen(port, "merchant");
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
        this.ucp.settleByReference(item.merchantReference, {
          resultCode: success ? "Authorised" : "Refused",
          pspReference: item.pspReference,
          refusalReason: item.reason || undefined,
        });
      }
      const order = this.store.orderByPspReference(item.pspReference);
      const event = `${item.eventCode}:${item.success}`;
      if (order && !order.webhookEvents.includes(event)) order.webhookEvents.push(event);
    }
    return { status: 200, body: "[accepted]" };
  }
}
