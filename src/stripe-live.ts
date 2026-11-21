import { MERCHANT_PORT, config } from "./config.ts";
import { Merchant } from "./merchant/server.ts";
import { createAgent, createToolset } from "./agent/factory.ts";
import { dashboardPaymentUrl, stripeCall } from "./stripe-api.ts";

if (config.stripe.mode !== "test" || !config.stripe.apiBase.startsWith("https://api.stripe.com")) {
  throw new Error("npm run stripe:live needs STRIPE_SECRET_KEY=sk_test_... (in .env) and no STRIPE_API_BASE override");
}

const request = process.argv.slice(2).join(" ") || "Buy 2 bags of the coffee beans and a pack of paper filters";
const shop = new Merchant();
const server = await shop.listen(MERCHANT_PORT);
try {
  const toolset = createToolset(async (summary) => {
    console.log(`\n\x1b[33mShopper approval (auto):\x1b[0m\n${summary}\n`);
    return true;
  }, "stripe");
  const agent = createAgent({ toolset, onToolCall: (name, input) => console.log(`\n\x1b[36m⚙ ${name}\x1b[0m ${JSON.stringify(input)}`) }, "scripted");
  console.log(`\nagent: ${agent.label} | protocol: acp (merchant-hosted) | stripe: test mode\nyou> ${request}`);
  const reply = await agent.send(request);
  console.log(`\n\x1b[32magent>\x1b[0m ${reply}`);

  const orderId = /\/orders\/([\w-]+)/.exec(reply)?.[1];
  const order = orderId ? shop.orders.get(orderId) : undefined;
  if (!order) throw new Error("no order was placed");
  const intent = await stripeCall("GET", `/v1/payment_intents/${encodeURIComponent(order.pspReference)}`, { label: "check→stripe" });
  console.log(`\norder:          ${order.id} (${order.amount} ${order.currency} minor units)`);
  console.log(`PaymentIntent:  ${order.pspReference}`);
  console.log(`status:         ${intent.body?.status ?? `unknown (HTTP ${intent.status})`}`);
  console.log(`dashboard:      ${dashboardPaymentUrl(order.pspReference)}`);
  if (intent.body?.status !== "succeeded") process.exitCode = 1;
} finally {
  server.close();
}
