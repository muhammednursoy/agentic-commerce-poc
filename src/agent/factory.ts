import { config } from "../config.ts";
import { AgentPlatform } from "./acp/platform.ts";
import { AcpToolset } from "./acp/tools.ts";
import { ClaudeAgent } from "./llm/claude.ts";
import { GeminiAgent } from "./llm/gemini.ts";
import { ScriptedAgent } from "./llm/scripted.ts";
import type { AgentOptions, ChatAgent } from "./llm/types.ts";
import type { Confirm, Toolset } from "./toolset.ts";
import { UcpPlatform } from "./ucp/platform.ts";
import { UcpToolset } from "./ucp/tools.ts";

export function createToolset(confirm: Confirm, protocol: "acp" | "ucp" = config.protocol): Toolset {
  return protocol === "acp" ? new AcpToolset(new AgentPlatform(), confirm) : new UcpToolset(new UcpPlatform(), confirm);
}

export function createAgent(options: AgentOptions, provider = process.env.LLM_PROVIDER): ChatAgent {
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const chosen = provider || (geminiKey ? "gemini" : process.env.ANTHROPIC_API_KEY ? "claude" : "scripted");
  switch (chosen) {
    case "gemini":
      if (!geminiKey) throw new Error("LLM_PROVIDER=gemini needs GEMINI_API_KEY (free key: https://aistudio.google.com/apikey)");
      return new GeminiAgent(options, geminiKey);
    case "claude":
      return new ClaudeAgent(options);
    case "scripted":
      return new ScriptedAgent(options);
    default:
      throw new Error(`unknown LLM_PROVIDER ${chosen}; use gemini, claude or scripted`);
  }
}
