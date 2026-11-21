export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type Confirm = (summary: string) => Promise<boolean>;

export interface CheckoutSummary {
  id: string;
  status: string;
  ready: boolean;
  currency: string;
  line_items: { product_id: string; title: string; quantity: number; total: number }[];
  fulfillment_options: { id: string; title: string; subtitle: string; total: number }[];
  selected_fulfillment_option_id: string | null;
  totals: Record<string, number>;
  messages: { type: string; code?: string; severity?: string; content: string }[];
  order?: { id: string; permalink_url: string };
  continue_url?: string;
}

export interface Toolset {
  readonly protocol: "acp" | "ucp";
  readonly definitions: ToolDefinition[];
  readonly system: string;
  readonly names: { list: string; create: string; update: string; pay: string };
  execute(name: string, input: Record<string, any>): Promise<unknown>;
}

export function itemsInput(value: unknown): { id: string; quantity: number }[] {
  const ok = Array.isArray(value) && value.length > 0
    && value.every((i) => typeof i?.id === "string" && Number.isInteger(i?.quantity) && i.quantity >= 1);
  if (!ok) throw new Error("items must be a non-empty array of { id: string, quantity: positive integer }");
  return value;
}

export function stringInput(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function toolError(err: unknown): { error: string } {
  return { error: err instanceof Error ? err.message : String(err) };
}

export function isToolError(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output;
}

export const sessionIdSchema ={ type: "string", description: "Checkout session id returned by the create tool" };

export const itemsSchema = {
  type: "array",
  minItems: 1,
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "Product id from list_products" },
      quantity: { type: "integer", minimum: 1 },
    },
    required: ["id", "quantity"],
    additionalProperties: false,
  },
};
