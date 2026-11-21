import { ClaudeAgent } from "./llm/claude.ts";
import { GeminiAgent } from "./llm/gemini.ts";
import { ScriptedAgent } from "./llm/scripted.ts";
import type { AgentOptions, ChatAgent } from "./llm/types.ts";

export function createAgent(options: AgentOptions, provider = process.env.LLM_PROVIDER): ChatAgent {
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const chosen = provider ?? (geminiKey ? "gemini" : process.env.ANTHROPIC_API_KEY ? "claude" : "scripted");
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
