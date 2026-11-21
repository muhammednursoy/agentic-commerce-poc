import { randomId } from "../http.ts";
import type { Item } from "../acp.ts";

export interface Product {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  stock: number;
}

export interface MerchantOrder {
  id: string;
  protocol: "acp" | "ucp";
  checkoutSessionId: string;
  pspReference: string;
  amount: number;
  currency: string;
  items: Item[];
  createdAt: string;
  webhookEvents: string[];
}

export type ProblemCode =
  | "invalid_item"
  | "currency_unsupported"
  | "product_out_of_stock"
  | "product_partial_stock"
  | "shipping_destination_unsupported";

export interface PriceProblem {
  code: ProblemCode;
  content: string;
  lineIndex?: number;
}

export interface PricedLine {
  product: Product;
  quantity: number;
  subtotal: number;
  tax: number;
  total: number;
}

export interface ShippingOption {
  id: string;
  title: string;
  subtitle: string;
  amount: number;
}

export interface Pricing {
  lines: PricedLine[];
  options: ShippingOption[];
  chosen?: ShippingOption;
  itemsSubtotal: number;
  tax: number;
  fulfillment: number;
  total: number;
  problems: PriceProblem[];
}

export interface Destination {
  country: string;
  state?: string;
}

const TAX_RATES: Record<string, number> = { NY: 0.08875, CA: 0.0725, TX: 0.0625 };
const DEFAULT_TAX_RATE = 0.06;
const FREE_SHIPPING_FROM = 10000;
export const RISK_LIMIT = 500000;

export function defaultCatalog(): Product[] {
  return [
    { id: "sku_coffee_beans", title: "Ethiopia Yirgacheffe coffee beans 1 kg", description: "Light roast, whole beans", price: 2899, currency: "USD", stock: 25 },
    { id: "sku_pour_over", title: "Ceramic pour-over dripper", description: "Size 02, white", price: 3450, currency: "USD", stock: 8 },
    { id: "sku_grinder", title: "Burr coffee grinder", description: "40 grind settings, conical burrs", price: 14900, currency: "USD", stock: 3 },
    { id: "sku_kettle", title: "Gooseneck kettle 1 L", description: "Electric, temperature control", price: 7900, currency: "USD", stock: 0 },
    { id: "sku_filters", title: "Paper filters (100 pcs)", description: "Fits size 02 drippers", price: 699, currency: "USD", stock: 200 },
  ];
}

export class MerchantStore {
  readonly catalog: Map<string, Product>;
  readonly orders = new Map<string, MerchantOrder>();
  private readonly reserved = new Map<string, number>();

  constructor(products: Product[] = defaultCatalog()) {
    this.catalog = new Map(products.map((p) => [p.id, { ...p }]));
  }

  price(currency: string, items: Item[], destination?: Destination, optionId?: string): Pricing {
    const problems: PriceProblem[] = [];
    const lines: PricedLine[] = [];
    items.forEach((item, lineIndex) => {
      const product = this.catalog.get(item.id);
      if (!product) return problems.push({ code: "invalid_item", content: `Unknown product ${item.id}`, lineIndex });
      if (product.currency !== currency) {
        return problems.push({ code: "currency_unsupported", content: `${product.id} is sold in ${product.currency}`, lineIndex });
      }
      if (product.stock === 0) return problems.push({ code: "product_out_of_stock", content: `${product.title} is out of stock`, lineIndex });
      if (product.stock < item.quantity) {
        return problems.push({ code: "product_partial_stock", content: `Only ${product.stock} of ${product.title} left`, lineIndex });
      }
      const subtotal = product.price * item.quantity;
      lines.push({ product, quantity: item.quantity, subtotal, tax: 0, total: subtotal });
    });

    const itemsSubtotal = lines.reduce((s, l) => s + l.subtotal, 0);
    let options: ShippingOption[] = [];
    let taxRate = 0;
    if (destination) {
      if (destination.country !== "US") {
        problems.push({ code: "shipping_destination_unsupported", content: "This store only ships within the US" });
      } else {
        taxRate = TAX_RATES[destination.state ?? ""] ?? DEFAULT_TAX_RATE;
        options = [
          { id: "ship_standard", title: "Standard shipping", subtitle: "5-7 business days", amount: itemsSubtotal >= FREE_SHIPPING_FROM ? 0 : 599 },
          { id: "ship_express", title: "Express shipping", subtitle: "1-2 business days", amount: 1999 },
        ];
      }
    }
    for (const line of lines) {
      line.tax = Math.round(line.subtotal * taxRate);
      line.total = line.subtotal + line.tax;
    }
    const chosen = options.find((o) => o.id === optionId);
    const tax = lines.reduce((s, l) => s + l.tax, 0);
    const fulfillment = chosen?.amount ?? 0;
    return { lines, options, chosen, itemsSubtotal, tax, fulfillment, total: itemsSubtotal + fulfillment + tax, problems };
  }

  newOrderId(): string {
    return randomId("ord_", 5);
  }

  reserve(items: Item[]): string | undefined {
    const wanted = new Map<string, number>();
    for (const item of items) wanted.set(item.id, (wanted.get(item.id) ?? 0) + item.quantity);
    for (const [id, quantity] of wanted) {
      const product = this.catalog.get(id);
      const free = (product?.stock ?? 0) - (this.reserved.get(id) ?? 0);
      if (free < quantity) return `Only ${Math.max(0, free)} of ${product?.title ?? id} available`;
    }
    for (const [id, quantity] of wanted) this.reserved.set(id, (this.reserved.get(id) ?? 0) + quantity);
    return undefined;
  }

  release(items: Item[]): void {
    for (const item of items) {
      const left = (this.reserved.get(item.id) ?? 0) - item.quantity;
      if (left > 0) this.reserved.set(item.id, left);
      else this.reserved.delete(item.id);
    }
  }

  recordOrder(order: Omit<MerchantOrder, "createdAt" | "webhookEvents">): MerchantOrder {
    this.release(order.items);
    for (const item of order.items) {
      const product = this.catalog.get(item.id);
      if (product) product.stock -= item.quantity;
    }
    const saved: MerchantOrder = { ...order, createdAt: new Date().toISOString(), webhookEvents: [] };
    this.orders.set(saved.id, saved);
    return saved;
  }

  orderByPspReference(psp: string): MerchantOrder | undefined {
    return [...this.orders.values()].find((o) => o.pspReference === psp);
  }
}
