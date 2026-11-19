import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLLMAdapter } from "./llm/providers";
import { runAgentTurn, type SessionState } from "./agent-loop";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT_DIR = process.cwd();
const adapter = createLLMAdapter();
const sessions = new Map<string, SessionState>();

function getOrCreateSession(id: string): SessionState {
  let s = sessions.get(id);
  if (!s) {
    s = { id, messages: [], toolHistory: [], totalTokens: 0, needsConfirmation: false };
    sessions.set(id, s);
  }
  return s;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return Response.json({ ok: true, provider: adapter.provider, model: adapter.model });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const sessionId = url.pathname.replace("/api/sessions/", "");
      const session = getOrCreateSession(sessionId);
      return Response.json(session);
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      try {
        const body = (await req.json()) as { sessionId?: string; message?: string };
        if (!body.message?.trim()) {
          return Response.json({ ok: false, error: "El mensaje no puede estar vacío." }, { status: 400 });
        }
        const session = getOrCreateSession(body.sessionId || "default");
        const result = await runAgentTurn(adapter, session, body.message, ROOT_DIR);
        return Response.json(result);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return Response.json({
          reply: `Error al comunicarse con el proveedor LLM: ${errorMsg}`,
          toolCalls: [],
          needsConfirmation: false,
        });
      }
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await fs.readFile(path.join(ROOT_DIR, "web", "index.html"), "utf-8");
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Agente de Contratos Vigentes activo en http://localhost:${PORT} [${adapter.provider}/${adapter.model}]`);
