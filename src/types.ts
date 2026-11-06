export type ExecutionMode = 'safe' | 'hybrid' | 'auto';
export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface ToolCall { id: string; name: string; args: Record<string, unknown>; }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  models: string[];
  defaultModel?: string;
}

export interface StreamOpts {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal: AbortSignal;
}

export interface StreamHandlers {
  onText(t: string): void;
  onToolCall(c: ToolCall): void;
  onDone(stopReason: string): void;
}

export interface IProvider {
  listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]>;
  stream(opts: StreamOpts, h: StreamHandlers): Promise<void>;
}
