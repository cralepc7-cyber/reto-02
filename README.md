# Registro de Contratos Vigentes · Reto Técnico 02

Agente conversacional completo e independiente para automatizar la recepción, validación, archivo y monitoreo de contratos vigentes desde un buzón único (`Periferia IT Group`).

## Arranque en local (1 comando)

1. Copia el archivo de variables de entorno y configura tu clave API:
   ```bash
   cp .env.example .env
   ```
2. Instala dependencias y levanta el servidor (backend + interfaz de chat):
   ```bash
   bun install && bun run dev
   ```
3. Abre en tu navegador: `http://localhost:3000`

## Verificación determinista sin modelo LLM

Para validar todas las herramientas (`leer_buzon`, `extraer`, `validar`, `registrar`, `alertas`) sin consumir tokens ni requerir clave API:

```bash
bun install && bun run demo.ts
```

## Variables de entorno (`.env.example`)

- `LLM_PROVIDER`: `gemini` | `openai` | `anthropic` | `mock`
- `LLM_MODEL`: Ej. `gemini-2.5-flash`, `gpt-4o-mini`, `claude-3-5-sonnet-latest`
- `LLM_API_KEY`: Clave secreta del proveedor elegido (solo backend).
- `PORT`: Puerto HTTP (por defecto `3000`).
- `MAX_ITERATIONS`: Tope de llamadas herramienta → modelo por turno (`25`).
- `MAX_SESSION_TOKENS`: Límite de consumo por sesión (`100000`).
- `LLM_TIMEOUT_MS`: Tiempo máximo de espera al proveedor (`45000`).

## Endpoints de API

- `POST /api/chat`: `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation }`
- `GET /api/sessions/:id`: Historial completo de mensajes y herramientas ejecutadas en la sesión.
- `GET /api/health`: `{ ok: true, provider, model }` (sin exponer credenciales).

## Link de prueba

- Local: `http://localhost:3000` (listo para despliegue inmediato en Render, Railway, Fly.io o túnel HTTPS público sin clave de acceso adicional).
