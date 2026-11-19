import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { ChatMessage, LLMAdapter, ToolSpec } from "./llm/adapter";
import * as contratoTools from "./tools/contratos";

export interface ExecutedToolLog {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface SessionState {
  id: string;
  messages: ChatMessage[];
  toolHistory: ExecutedToolLog[];
  totalTokens: number;
  needsConfirmation: boolean;
}

const TOOL_REGISTRY: Record<
  string,
  {
    description: string;
    schema: z.ZodObject<z.ZodRawShape>;
    execute: (args: never, ctx: { directory: string; sessionId: string }) => Promise<string>;
  }
> = {
  contratos_leer_buzon: {
    description: contratoTools.leer_buzon.description,
    schema: z.object(contratoTools.leer_buzon.args),
    execute: contratoTools.leer_buzon.execute as never,
  },
  contratos_extraer: {
    description: contratoTools.extraer.description,
    schema: z.object(contratoTools.extraer.args),
    execute: contratoTools.extraer.execute as never,
  },
  contratos_validar: {
    description: contratoTools.validar.description,
    schema: z.object(contratoTools.validar.args),
    execute: contratoTools.validar.execute as never,
  },
  contratos_registrar: {
    description: contratoTools.registrar.description,
    schema: z.object(contratoTools.registrar.args),
    execute: contratoTools.registrar.execute as never,
  },
  contratos_alertas: {
    description: contratoTools.alertas.description,
    schema: z.object(contratoTools.alertas.args),
    execute: contratoTools.alertas.execute as never,
  },
  contratos_leer_pdf: {
    description: contratoTools.leer_pdf.description,
    schema: z.object(contratoTools.leer_pdf.args),
    execute: contratoTools.leer_pdf.execute as never,
  },
};

function zodFieldToJsonSchema(zodType: z.ZodTypeAny): Record<string, unknown> {
  const desc = zodType.description ?? "";
  if (zodType instanceof z.ZodOptional) {
    return zodFieldToJsonSchema(zodType._def.innerType);
  }
  if (zodType instanceof z.ZodBoolean) {
    return { type: "boolean", description: desc };
  }
  if (zodType instanceof z.ZodNumber) {
    return { type: "number", description: desc };
  }
  if (zodType instanceof z.ZodRecord || zodType instanceof z.ZodObject) {
    return { type: "object", description: desc };
  }
  return { type: "string", description: desc };
}

export function getToolSpecs(): ToolSpec[] {
  return Object.entries(TOOL_REGISTRY).map(([name, def]) => {
    const required: string[] = [];
    const properties: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(def.schema.shape)) {
      const zField = v as z.ZodTypeAny;
      properties[k] = zodFieldToJsonSchema(zField);
      if (!(zField instanceof z.ZodOptional)) {
        required.push(k);
      }
    }
    return {
      name,
      description: def.description,
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  });
}

export async function runAgentTurn(
  adapter: LLMAdapter,
  session: SessionState,
  userMessage: string,
  directory: string
): Promise<{ reply: string; toolCalls: ExecutedToolLog[]; needsConfirmation: boolean }> {
  const maxIterations = Number(process.env.MAX_ITERATIONS ?? 25);
  const maxTokens = Number(process.env.MAX_SESSION_TOKENS ?? 100000);

  if (session.messages.length === 0) {
    const promptMd = await fs.readFile(path.join(directory, "agent", "prompt.md"), "utf-8");
    const knowledgeMd = await fs.readFile(path.join(directory, "src", "knowledge", "registro-contratos.md"), "utf-8");
    session.messages.push({
      role: "system",
      content: `${promptMd}\n\n---\n${knowledgeMd}`,
    });
  }

  session.messages.push({ role: "user", content: userMessage });
  const turnToolCalls: ExecutedToolLog[] = [];
  let iterations = 0;

  while (iterations < maxIterations) {
    if (session.totalTokens >= maxTokens) {
      const msg = "Se alcanzó el límite de tokens configurado para esta sesión.";
      session.messages.push({ role: "assistant", content: msg });
      return { reply: msg, toolCalls: turnToolCalls, needsConfirmation: false };
    }

    iterations++;
    const response = await adapter.enviar(session.messages, getToolSpecs());
    session.totalTokens += response.usageTokens ?? 0;

    if (response.toolCalls.length === 0) {
      const needsConfirmation = /confirm(ar|as|o|ación)|¿deseas\s+confirmar|requiere\s+revisi[óo]n/i.test(response.content);
      session.needsConfirmation = needsConfirmation;
      session.messages.push({ role: "assistant", content: response.content });
      return { reply: response.content, toolCalls: turnToolCalls, needsConfirmation };
    }

    session.messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    for (const tc of response.toolCalls) {
      const toolDef = TOOL_REGISTRY[tc.name];
      let rawResult: string;

      if (!toolDef) {
        rawResult = JSON.stringify({ ok: false, error: `Herramienta desconocida: ${tc.name}` });
      } else {
        const parsedArgs = toolDef.schema.safeParse(tc.arguments);
        if (!parsedArgs.success) {
          rawResult = JSON.stringify({ ok: false, error: parsedArgs.error.message });
        } else {
          rawResult = await toolDef.execute(parsedArgs.data as never, {
            directory,
            sessionId: session.id,
          });
        }
      }

      const parsedResult = JSON.parse(rawResult);
      const logItem: ExecutedToolLog = { name: tc.name, args: tc.arguments, result: parsedResult };
      turnToolCalls.push(logItem);
      session.toolHistory.push(logItem);

      session.messages.push({
        role: "tool",
        toolCallId: tc.id,
        toolName: tc.name,
        content: rawResult,
      });
    }
  }

  const limitReply = "Se alcanzó el tope de iteraciones por turno. Revisa el progreso parcial en el historial.";
  session.messages.push({ role: "assistant", content: limitReply });
  return { reply: limitReply, toolCalls: turnToolCalls, needsConfirmation: false };
}
