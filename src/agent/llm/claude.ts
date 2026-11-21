import Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS } from "../tools.ts";
import type { AgentOptions, ChatAgent } from "./types.ts";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export class ClaudeAgent implements ChatAgent {
  readonly label: string;
  private readonly client = new Anthropic();
  private readonly model: string;
  private readonly options: AgentOptions;
  private readonly messages: MessageParam[] = [];

  constructor(options: AgentOptions, model = process.env.CLAUDE_MODEL ?? DEFAULT_CLAUDE_MODEL) {
    this.model = model;
    this.options = options;
    this.label = `claude (${model})`;
  }

  async send(userText: string): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    const tools: Anthropic.Beta.Messages.BetaTool[] = TOOL_DEFINITIONS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
    }));
    const maxSteps = this.options.maxSteps ?? 15;
    for (let step = 0; step < maxSteps; step++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: this.options.system,
        tools,
        messages: this.messages,
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      this.messages.push({ role: "assistant", content: response.content });

      if (response.stop_reason === "refusal") return "(the model declined this request)";
      if (response.stop_reason === "pause_turn") continue;
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (response.stop_reason !== "tool_use") return text;

      const results: ToolResult[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        this.options.onToolCall?.(block.name, block.input);
        const output = await this.options.tools.execute(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output) });
      }
      this.messages.push({ role: "user", content: results });
    }
    return "(stopped: too many tool steps)";
  }
}
