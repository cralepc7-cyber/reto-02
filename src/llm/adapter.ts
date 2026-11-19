export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: ToolCallRequest[];
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  usageTokens?: number;
}

export interface LLMAdapter {
  readonly provider: string;
  readonly model: string;
  enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LLMResponse>;
}
