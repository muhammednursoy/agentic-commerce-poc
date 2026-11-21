import { GoogleGenAI } from "@google/genai";
import type { Content, Part } from "@google/genai";
import type { AgentOptions, ChatAgent } from "./types.ts";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export class GeminiAgent implements ChatAgent {
  readonly label: string;
  private readonly ai: GoogleGenAI;
  private readonly model: string;
  private readonly options: AgentOptions;
  private readonly history: Content[] = [];

  constructor(options: AgentOptions, apiKey: string, model = process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) {
    this.ai = new GoogleGenAI({ apiKey });
    this.model = model;
    this.options = options;
    this.label = `gemini (${model})`;
  }

  async send(userText: string): Promise<string> {
    const { toolset } = this.options;
    this.history.push({ role: "user", parts: [{ text: userText }] });
    const maxSteps = this.options.maxSteps ?? 15;
    for (let step = 0; step < maxSteps; step++) {
      const response = await this.ai.models.generateContent({
        model: this.model,
        contents: this.history,
        config: {
          systemInstruction: toolset.system,
          tools: [{
            functionDeclarations: toolset.definitions.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          }],
        },
      });
      const content = response.candidates?.[0]?.content;
      if (content) this.history.push(content);
      const calls = response.functionCalls ?? [];
      if (calls.length === 0) return response.text ?? "";

      const parts: Part[] = [];
      for (const call of calls) {
        const name = call.name ?? "";
        this.options.onToolCall?.(name, call.args);
        const output = await toolset.execute(name, call.args ?? {});
        parts.push({ functionResponse: { id: call.id, name, response: { output } } });
      }
      this.history.push({ role: "user", parts });
    }
    return "(stopped: too many tool steps)";
  }
}
