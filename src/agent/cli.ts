import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { config } from "../config.ts";
import { createAgent, createToolset } from "./factory.ts";

const args = process.argv.slice(2);
const autoApprove = args.includes("--yes");
const firstMessage = args.filter((a) => a !== "--yes").join(" ").trim();

const rl = createInterface({ input: stdin, output: stdout });
const toolset = createToolset(async (summary) => {
  console.log(`\n\x1b[33mApprove this purchase?\x1b[0m\n${summary}`);
  if (autoApprove) {
    console.log("  → auto-approved (--yes)");
    return true;
  }
  const answer = await rl.question("  approve? [y/N] ");
  return /^(y|yes|e|evet)$/i.test(answer.trim());
});
const agent = createAgent({
  toolset,
  onToolCall: (name, input) => console.log(`\x1b[36m⚙ ${name}\x1b[0m ${JSON.stringify(input)}`),
});

const provider = config.protocol === "stripe"
  ? `stripe: ${config.stripe.mode}`
  : `adyen: ${config.mode}${toolset.protocol === "acp" ? ` | merchant flow: ${config.merchantFlow}` : ""}`;
console.log(`agent: ${agent.label} | protocol: ${toolset.protocol} | ${provider}`);
let message = firstMessage || (await rl.question("you> "));
while (message.trim()) {
  try {
    const reply = await agent.send(message);
    console.log(`\x1b[32magent>\x1b[0m ${reply}`);
  } catch (err) {
    console.error(`\x1b[31merror:\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!stdin.isTTY && firstMessage) break;
  message = await rl.question("you> ").catch(() => "");
}
rl.close();
