import { setTimeout as sleep } from "node:timers/promises";
import { MERCHANT_PORT, MOCK_PORT, config } from "./config.ts";
import { callJson } from "./http.ts";
import { Merchant } from "./merchant/server.ts";
import { MockAdyen } from "./mock-adyen/server.ts";
import { createAgent, createToolset } from "./agent/factory.ts";

if (config.mode !== "mock") throw new Error("npm run demo runs against the local mock; unset ADYEN_MODE");

const adyen = await new MockAdyen().listen(MOCK_PORT);
const shop = new Merchant();
const merchant = await shop.listen(MERCHANT_PORT);

const request = process.argv.slice(2).join(" ") || "Buy 2 bags of the coffee beans and a pack of paper filters";
const toolset = createToolset(async (summary) => {
  console.log(`\n\x1b[33mShopper approval (auto):\x1b[0m\n${summary}\n`);
  return true;
});
const agent = createAgent({
  toolset,
  onToolCall: (name, input) => console.log(`\n\x1b[36m⚙ ${name}\x1b[0m ${JSON.stringify(input)}`),
});

console.log(`\nagent: ${agent.label} | protocol: ${toolset.protocol}\nyou> ${request}`);
try {
  const reply = await agent.send(request);
  console.log(`\n\x1b[32magent>\x1b[0m ${reply}`);
  const orderUrl = /https?:\/\/\S+\/orders\/([\w-]+)/.exec(reply);
  if (orderUrl) {
    for (let i = 0; i < 100 && !shop.orders.get(orderUrl[1])?.webhookEvents.length; i++) await sleep(10);
    await callJson("GET", orderUrl[0], { label: "shopper→merchant order page" });
  }
} finally {
  adyen.close();
  merchant.close();
}
