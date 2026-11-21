import type { AgentTools } from "../tools.ts";

export interface ChatAgent {
  readonly label: string;
  send(userText: string): Promise<string>;
}

export interface AgentOptions {
  tools: AgentTools;
  system: string;
  onToolCall?: (name: string, input: unknown) => void;
  maxSteps?: number;
}
