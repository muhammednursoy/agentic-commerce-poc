import type { Toolset } from "../toolset.ts";

export interface ChatAgent {
  readonly label: string;
  send(userText: string): Promise<string>;
}

export interface AgentOptions {
  toolset: Toolset;
  onToolCall?: (name: string, input: unknown) => void;
  maxSteps?: number;
}
