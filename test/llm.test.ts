import { test } from "node:test";
import assert from "node:assert/strict";
import type { Toolset } from "../src/agent/toolset.ts";

delete process.env.ANTHROPIC_API_KEY;
const { GeminiAgent } = await import("../src/agent/llm/gemini.ts");
const { ClaudeAgent } = await import("../src/agent/llm/claude.ts");

const toolset: Toolset = {
  protocol: "ucp",
  system: "system prompt",
  names: { list: "t", create: "t", update: "t", pay: "t" },
  definitions: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }],
  execute: async (name) => (name === "boom" ? { error: "bad input" } : { ok: true }),
};

type Script = unknown[];

function geminiCall(name: string) {
  const call = { id: `c_${name}`, name, args: {} };
  return { candidates: [{ content: { role: "model", parts: [{ functionCall: call }] } }], functionCalls: [call] };
}

const geminiSay = (text: string) => ({ candidates: [{ content: { role: "model", parts: [{ text }] } }], text });

function gemini(script: Script, maxSteps?: number) {
  const agent = new GeminiAgent({ toolset, maxSteps }, "fake-key", "fake-model");
  Object.assign(agent, { ai: { models: { generateContent: async () => script.shift() ?? geminiCall("t") } } });
  return { agent, history: (agent as unknown as { history: { role: string; parts: any[] }[] }).history };
}

test("Gemini loop: tool results go back by call id and name, errors included; roles alternate", async () => {
  const { agent, history } = gemini([geminiCall("t"), geminiCall("boom"), geminiSay("done")]);
  assert.equal(await agent.send("hi"), "done");
  assert.deepEqual(history.map((h) => h.role), ["user", "model", "user", "model", "user", "model"]);
  assert.deepEqual(history[4].parts[0].functionResponse, { id: "c_boom", name: "boom", response: { output: { error: "bad input" } } });
});

test("Gemini loop: the step cap stops the loop and an empty candidate is reported without touching history", async () => {
  assert.equal(await gemini([], 3).agent.send("hi"), "(stopped: too many tool steps)");
  const empty = gemini([{ candidates: [{ finishReason: "SAFETY" }] }]);
  assert.equal(await empty.agent.send("hi"), "(no reply from the model: SAFETY)");
  assert.deepEqual(empty.history.map((h) => h.role), ["user"]);
});

function claude(script: Script, maxSteps?: number) {
  const agent = new ClaudeAgent({ toolset, maxSteps }, "fake-model");
  const fallback = { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x", name: "t", input: {} }] };
  Object.assign(agent, { client: { beta: { messages: { create: async () => script.shift() ?? fallback } } } });
  return { agent, messages: (agent as unknown as { messages: { role: string; content: any }[] }).messages };
}

const use = (id: string, name: string) => ({ type: "tool_use", id, name, input: {} });

test("Claude loop: tool results carry the call id and is_error; a reply cut inside a tool call is dropped", async () => {
  const { agent, messages } = claude([
    { stop_reason: "tool_use", content: [{ type: "text", text: "calling" }, use("a", "t"), use("b", "boom")] },
    { stop_reason: "max_tokens", content: [{ type: "text", text: "cut" }, use("c", "t")] },
  ]);
  assert.equal(await agent.send("hi"), "(stopped: max_tokens cut the reply inside a tool call)");
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(messages[2].content.map((r: { tool_use_id: string; is_error: boolean }) => [r.tool_use_id, r.is_error]), [["a", false], ["b", true]]);
});

test("Claude loop: a text reply ends the turn, the step cap stops the loop, a refusal is reported", async () => {
  assert.equal(await claude([{ stop_reason: "end_turn", content: [{ type: "text", text: "Order placed" }] }]).agent.send("hi"), "Order placed");
  assert.equal(await claude([], 2).agent.send("hi"), "(stopped: too many tool steps)");
  assert.equal(await claude([{ stop_reason: "refusal", content: [] }]).agent.send("hi"), "(the model declined this request)");
});
