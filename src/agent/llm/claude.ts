import Anthropic from "@anthropic-ai/sdk";
import { isToolError } from "../toolset.ts";
import type { AgentOptions, ChatAgent } from "./types.ts";

export const DEFAULT_CLAUDE_MODEL = "claude-haiku-5-5";
const SERVER_FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]);
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export class ClaudeAgent implements ChatAgent {
  readonly label: string;
  private readonly client = new Anthropic();
  private readonly model: string;
  private readonly options: AgentOptions;
  private readonly messages: MessageParam[] = [];
  private readonly effort: Effort;

  constructor(options: AgentOptions, model = process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL) {
    this.model = model;
    this.options = options;
    this.effort = (process.env.AGENT_CLAUDE_EFFORT as Effort) || (model.startsWith("claude-haiku") ? "low" : "medium");
    this.label = `claude (${model}, effort ${this.effort})`;
  }

  async send(userText: string): Promise<string> {
    const { toolset } = this.options;
    this.messages.push({ role: "user", content: userText });
    const tools: Anthropic.Beta.Messages.BetaTool[] = toolset.definitions.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.Messages.BetaTool.InputSchema,
    }));
    const maxSteps = this.options.maxSteps ?? 15;
    for (let step = 0; step < maxSteps; step++) {
      const response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        system: toolset.system,
        tools,
        messages: this.messages,
        output_config: { effort: this.effort },
        ...(SERVER_FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      if (response.stop_reason === "refusal") return "(the model declined this request)";
      this.messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
      if (response.stop_reason !== "tool_use") {
        if (response.content.some((b) => b.type === "tool_use")) {
          this.messages.pop();
          return `(stopped: ${response.stop_reason} cut the reply inside a tool call)`;
        }
        return text;
      }

      const results: ToolResult[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        this.options.onToolCall?.(block.name, block.input);
        const output = await toolset.execute(block.name, block.input as Record<string, unknown>);
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(output), is_error: isToolError(output) });
      }
      this.messages.push({ role: "user", content: results });
    }
    return "(stopped: too many tool steps)";
  }
}
