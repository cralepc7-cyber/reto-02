import type { ChatMessage, LLMAdapter, LLMResponse, ToolSpec } from "./adapter";

export function createLLMAdapter(): LLMAdapter {
  const provider = (process.env.LLM_PROVIDER ?? "gemini").toLowerCase();
  const model = process.env.LLM_MODEL ?? "gemini-2.5-flash";
  const apiKey = process.env.LLM_API_KEY ?? "";
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 45000);

  if (provider === "openai") {
    return new OpenAIAdapter(model, apiKey, timeoutMs);
  }
  if (provider === "anthropic") {
    return new AnthropicAdapter(model, apiKey, timeoutMs);
  }
  if (provider === "gemini") {
    return new GeminiAdapter(model, apiKey, timeoutMs);
  }
  return new DeterministicFallbackAdapter(model);
}

class OpenAIAdapter implements LLMAdapter {
  readonly provider = "openai";
  constructor(readonly model: string, private apiKey: string, private timeoutMs: number) {}

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LLMResponse> {
    if (!this.apiKey) throw new Error("LLM_API_KEY no configurada para OpenAI.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: mensajes.map((m) => {
            if (m.role === "tool") {
              return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
            }
            if (m.toolCalls && m.toolCalls.length > 0) {
              return {
                role: "assistant",
                content: m.content || null,
                tool_calls: m.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
                })),
              };
            }
            return { role: m.role, content: m.content };
          }),
          tools: herramientas.map((h) => ({
            type: "function",
            function: { name: h.name, description: h.description, parameters: h.parameters },
          })),
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const choice = json.choices?.[0]?.message;
      const toolCalls = (choice?.tool_calls ?? []).map((tc: { id: string; function: { name: string; arguments: string } }) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments || "{}"),
      }));

      return {
        content: choice?.content ?? "",
        toolCalls,
        usageTokens: json.usage?.total_tokens ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class AnthropicAdapter implements LLMAdapter {
  readonly provider = "anthropic";
  constructor(readonly model: string, private apiKey: string, private timeoutMs: number) {}

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LLMResponse> {
    if (!this.apiKey) throw new Error("LLM_API_KEY no configurada para Anthropic.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const systemMsg = mensajes.find((m) => m.role === "system")?.content ?? "";
      const filtered = mensajes.filter((m) => m.role !== "system").map((m) => {
        if (m.role === "tool") {
          return {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
          };
        }
        if (m.toolCalls && m.toolCalls.length > 0) {
          return {
            role: "assistant",
            content: m.toolCalls.map((tc) => ({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })),
          };
        }
        return { role: m.role, content: m.content };
      });

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 4096,
          system: systemMsg,
          messages: filtered,
          tools: herramientas.map((h) => ({
            name: h.name,
            description: h.description,
            input_schema: h.parameters,
          })),
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const blocks = json.content ?? [];
      const textBlock = blocks.find((b: { type: string; text?: string }) => b.type === "text")?.text ?? "";
      const toolBlocks = blocks.filter((b: { type: string }) => b.type === "tool_use");

      return {
        content: textBlock,
        toolCalls: toolBlocks.map((b: { id: string; name: string; input: Record<string, unknown> }) => ({
          id: b.id,
          name: b.name,
          arguments: b.input ?? {},
        })),
        usageTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class GeminiAdapter implements LLMAdapter {
  readonly provider = "gemini";
  constructor(readonly model: string, private apiKey: string, private timeoutMs: number) {}

  async enviar(mensajes: ChatMessage[], herramientas: ToolSpec[]): Promise<LLMResponse> {
    if (!this.apiKey) throw new Error("LLM_API_KEY no configurada para Gemini.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const systemMsg = mensajes.find((m) => m.role === "system")?.content ?? "";
      const contents = mensajes
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (m.role === "tool") {
            return {
              role: "user",
              parts: [{ functionResponse: { name: m.toolName, response: JSON.parse(m.content) } }],
            };
          }
          if (m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: "model",
              parts: m.toolCalls.map((tc) => ({ functionCall: { name: tc.name, args: tc.arguments } })),
            };
          }
          return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
        });

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemMsg }] },
          contents,
          tools: [
            {
              functionDeclarations: herramientas.map((h) => ({
                name: h.name,
                description: h.description,
                parameters: h.parameters,
              })),
            },
          ],
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const textPart = parts.find((p: { text?: string }) => p.text)?.text ?? "";
      const fcParts = parts.filter((p: { functionCall?: { name: string; args: Record<string, unknown> } }) => p.functionCall);

      return {
        content: textPart,
        toolCalls: fcParts.map((p: { functionCall: { name: string; args: Record<string, unknown> } }, idx: number) => ({
          id: `call_${Date.now()}_${idx}`,
          name: p.functionCall.name,
          arguments: p.functionCall.args ?? {},
        })),
        usageTokens: json.usageMetadata?.totalTokenCount ?? 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

class DeterministicFallbackAdapter implements LLMAdapter {
  readonly provider = "mock";
  constructor(readonly model: string) {}
  async enviar(): Promise<LLMResponse> {
    throw new Error("Configure LLM_API_KEY en .env para ejecutar el modelo conversacional.");
  }
}
