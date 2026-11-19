# Planteamiento de la Solución — Agente "Registro de Contratos Vigentes"

## 1. Problema en una frase y a quién le duele

El registro maestro de contratos vigentes de Periferia IT Group está congelado desde el **30 de mayo de 2026** porque dependía manualmente de una sola persona y recibía únicamente contratos con póliza por canales dispersos, dejándonos sin visibilidad gerencial de vencimientos y exponiendo a la compañía a incumplimientos por pólizas no constituidas o vencidas.

**A quién le duele:**
- **Analista Administrativa**: Carece de un punto único de recepción y debe consolidar manualmente correos y archivos dispersos.
- **Gerencia / Dirección**: No puede responder qué contratos vencen en los próximos 60 días ni cuál es la exposición real por garantías pendientes.
- **Área Comercial**: Carece de un flujo claro y acuse de recibo para radicar contratos y otrosíes.

---

## 2. Arquitectura

```
┌──────────────────────┐   HTTP POST /api/chat   ┌───────────────────────────────────────────┐
│  Front: web/index.html│ ──────────────────────▶ │  Backend: src/server.ts + agent-loop.ts   │
│  - historial de chat │ ◀────────────────────── │  - ciclo iterativo con tope (CA1)         │
│  - visor toolCalls   │                         │  - prompt: agent/prompt.md                │
│  - alerta confirmar  │                         │  - conocimiento: src/knowledge/*.md       │
└──────────────────────┘                         └───────────┬───────────────────┬───────────┘
                                                             │                   │
                                                   ┌─────────▼─────────┐ ┌───────▼───────────┐
                                                   │ Adaptador LLM     │ │ Herramientas Zod  │
                                                   │ src/llm/adapter.ts│ │ src/tools/        │
                                                   │ (Gemini/OpenAI/   │ │ contratos.ts      │
                                                   │  Anthropic)       │ └───────┬───────────┘
                                                   └───────────────────┘         │
                                                                    ┌────────────┴────────────┐
                                                                    ▼                         ▼
                                                          fixtures/ (solo lectura)   out/ (escritura)
                                                                                     - sharepoint/maestro-contratos.csv
                                                                                     - sharepoint/Contratos/...
                                                                                     - sharepoint/historial.jsonl
                                                                                     - alertas.md / log.jsonl
```

**Separación de responsabilidades:**
- **Comportamiento (`agent/prompt.md`)**: Define las reglas operativas (`CA1`–`CA5`), el flujo estricto de herramientas y la prohibición de inventar datos.
- **Conocimiento (`src/knowledge/registro-contratos.md`)**: Documenta las reglas de negocio (`RN1`–`RN7`), normalización tributaria regional (`CO`, `EC`, `PE`, `PA`, `HN`) y criterios de alertas.
- **Ejecución (`src/tools/contratos.ts`)**: Única capa autorizada para leer `fixtures/` y escribir en `out/`, validando argumentos con `zod`.

---

## 3. Ciclo del agente

1. **Inicialización de sesión**: En el primer turno de cada `sessionId`, `runAgentTurn` carga dinámicamente `agent/prompt.md` y `src/knowledge/registro-contratos.md` como mensaje `system`.
2. **Bucle herramienta → modelo (`CA1`)**: El agente invoca al `LLMAdapter.enviar()` con el historial y las especificaciones derivadas de `zod`. Si el modelo solicita herramientas, se validan los esquemas con `safeParse`, se ejecutan de forma segura (sin `eval` ni comandos de shell), se registra cada llamada en `out/log.jsonl` (`CA4`) y se devuelven los resultados al modelo hasta alcanzar la respuesta final o el tope `MAX_ITERATIONS=25`.
3. **Confirmación humana (`CA3`)**: Si `contratos_validar` detecta campos con `confianza < 0.8` (como ocurre en `msg-006`), `contratos_registrar` rechaza la escritura sin `confirmado: true`. El agente detiene el registro de ese contrato, detalla los campos dudosos y cierra su turno con una pregunta explícita. El frontend resalta visualmente el estado (`needsConfirmation: true`) hasta que el usuario confirma en el siguiente turno.

---

## 4. Elección del modelo

- **Proveedor y modelo por defecto**: Google **Gemini 2.5 Flash** (`gemini-2.5-flash`), con soporte nativo intercambiable mediante variables de entorno (`LLM_PROVIDER`) para **OpenAI** (`gpt-4o-mini`) y **Anthropic** (`claude-3-5-sonnet-latest`).
- **Por qué**: Excelente precisión en *function calling* estructurado de múltiples pasos, baja latencia (< 1.5 s por iteración) y ventana de contexto amplia para procesar lotes completos sin truncamiento.
- **Costo estimado por caso procesado**: Procesar el buzón completo de 6 mensajes requiere ~4.200 tokens de entrada y ~900 tokens de salida. Con tarifas de Gemini 2.5 Flash (`$0.15 / 1M` input, `$0.60 / 1M` output), el costo por lote completo es de **~$0.0012 USD** (~`$0.0002 USD` por mensaje).

---

## 5. Estrategia de extracción y cálculo de confianza

La extracción en `contratos_extraer` es **100% determinista** sobre el texto del contrato (`P0`), garantizando que ningún monto ni fecha sea inventado por el LLM (`CA2`):

- **Partes e Identificador Tributario**: Expresiones regulares sobre la cláusula de comparecencia (`Entre ... NIT/RUC/RTN ...`), normalizando el identificador eliminando puntos, espacios y dígito de verificación (`890.900.111-4` → `890900111`). Confianza: `0.97`.
- **Valor y Moneda**: Detección de moneda (`COP`, `USD`, `PEN`, `PAB`, `HNL`) y montos numéricos (`0.96`). Si el texto indica contrato marco o por demanda (*"no tiene un valor determinado"*), se asigna `valor = 0`, `valor_indeterminado = true` y `confianza = 0.55` para forzar validación humana.
- **Plazo y Fechas**: Conversión determinista de fechas escritas en español (*"primero (1) de agosto de 2026"* → `2026-08-01`, confianza `0.97`). Cuando el documento solo indica mes/año de firma y duración en meses (`msg-006`: *"en el mes de agosto de 2026"*, *"doce (12) meses"*), se calcula una fecha referencial con confianza `0.60`–`0.65`, disparando `requiere_revision`.
- **Pólizas**: Detección de cláusula de garantías y tipificación (`cumplimiento`, `responsabilidad_civil`, `salarios_prestaciones`, `calidad`).
- **Comercial remitente**: Cruce exacto por correo electrónico contra `comerciales.json` (`0.99` si existe; `0.60` si es un remitente no catalogado como `jperez@periferia-ficticia.com`).

---

## 6. Propuesta de Regla de Gobierno (Sección 7.5)

Para evitar que el maestro vuelva a congelarse y garantizar trazabilidad completa:

1. **Canal único**: Toda documentación contractual debe enviarse exclusivamente al buzón corporativo **`contratos@periferia-ficticia.com`**. La propietaria y administradora del maestro es la **Analista Administrativa** (ante la ausencia de área legal interna), con respaldo operativo del Coordinador de Operaciones Comerciales.
2. **Obligación del comercial**: El ejecutivo comercial responsable debe radicar **todo** contrato firmado (requiera o no póliza), otrosíes, acuerdos marco y actas de terminación dentro de las **48 horas hábiles** siguientes a la firma, adjuntando el PDF firmado con texto seleccionable y utilizando el asunto estandarizado:
   `[CONTRATO | OTROSI | TERMINACION] - <Razón Social Cliente> - <Número Contrato>`
3. **Acuse automático**: En un plazo máximo de **2 minutos** tras la recepción, el agente responde al remitente con el número de radicado, la clasificación aplicada (`nuevo`, `actualizacion`, `duplicado` o `rechazado`) y, si aplica, la solicitud de aclaración de campos dudosos o confirmación de inicio de trámite de póliza.
4. **Excepciones y escalamiento**:
   - *Cotizaciones o borradores sin firma*: Se rechazan automáticamente (`RN4`) indicando que solo se radican documentos suscritos.
   - *Contratos sin valor determinado (marco) o fechas incompletas*: Quedan retenidos en bandeja de revisión humana (`RN5`). Si el comercial no confirma los parámetros en **3 días hábiles**, el caso se escala automáticamente al **Director Comercial Regional**.
5. **Cierre del gap (junio – agosto 2026)**: Campaña única de regularización de **5 días hábiles** liderada por Administración y Finanzas: se cruza el listado de facturas emitidas en el ERP entre el `2026-06-01` y el `2026-08-31` contra `maestro-contratos.csv`. Todo cliente facturado sin contrato vigente en el maestro genera una tarea obligatoria al comercial asignado antes del cierre contable mensual.
6. **Indicador de control (KPI mensual)**:
   $$	ext{Cobertura Contractual} = rac{	ext{Contratos facturados en el mes registrados y vigentes en el maestro}}{	ext{Total de contratos facturados en el mes}} 	imes 100 \quad (	ext{Meta} \ge 98\%)$$

---

## 7. Decisiones y Trade-offs

| Decisión | Alternativa descartada | Justificación |
|---|---|---|
| **Extracción determinista + LLM orquestador** | Dejar que el LLM extraiga directamente el JSON del texto | Evita alucinaciones o redondeos en valores monetarios y fechas (`CA2`), garantizando repetibilidad en `demo.ts`. |
| **Parser CSV RFC-4180 propio sin dependencias externas** | Librerías externas de CSV o base de datos SQLite | Cumple el requisito de almacenamiento plano en CSV (`O2`) manejando correctamente comas y comillas dentro de descripciones de objeto. |
| **Adaptador LLM ligero sobre `fetch` nativo** | SDKs pesados por cada proveedor | Reduce el tamaño de `node_modules`, acelera el arranque en `< 2 s` y permite cambiar entre Gemini, OpenAI y Anthropic tocando solo `.env`. |

---

## 8. Supuestos

- Los archivos adjuntos contienen texto extraíble (`contrato.txt` en fixtures; `contratos_leer_pdf` disponible para archivos planos en el proyecto).
- En contratos marco sin día exacto de firma (`msg-006`), se propone una fecha inicial tentativa con confianza `< 0.8` para que la analista confirme el día exacto (por ejemplo, la fecha de recepción del correo `2026-08-31` y fin `2027-08-31`).
- Un remitente fuera de `comerciales.json` genera advertencia en `requiere_revision` pero permite registrar el contrato una vez confirmado por la analista (`HU-3`).

---

## 9. Cobertura de Historias de Usuario

| Historia | Estado | Detalle y qué falta para producción |
|---|---|---|
| **HU-1 · Leer el buzón** | Hecho | Lista mensajes pendientes excluyendo `out/procesados.json` e identifica adjuntos no contractuales. En producción: conectar Microsoft Graph API (Exchange). |
| **HU-2 · Extraer datos** | Hecho | Esquema completo con confianza por campo en `[0, 1]`. En producción: integrar OCR (Azure Document Intelligence) para PDFs escaneados. |
| **HU-3 · Validar y clasificar** | Hecho | Implementa `RN1`–`RN5`, similitud de objeto, cruce por `id_contrato`/`nit_cliente` y validación contra `comerciales.json`. |
| **HU-4 · Registrar y archivar** | Hecho | Actualiza `out/sharepoint/maestro-contratos.csv`, archiva en ruta jerárquica y escribe `historial.jsonl`. En producción: API de SharePoint Online. |
| **HU-5 · Alertar** | Hecho | Genera `out/alertas.md` con las 3 secciones requeridas y fecha `hoy` parametrizable. En producción: envío programado por correo/Teams. |
| **HU-6 · Manejo de errores** | Hecho | Respuestas tipadas `{ ok: false, error }`, timeouts configurables y aislamiento por mensaje. |

---

## 10. Uso de IA

- **Asistente utilizado**: Gemini (Google).
- **Para qué tareas**: Diseño de la arquitectura modular, generación del boilerplate TypeScript estricto, patrones de expresiones regulares para fechas en español y redacción de la documentación técnica.
- **Qué se descartó y por qué**: Se descartó delegar al modelo la conversión de fechas relativas y cálculos de meses para evitar desviaciones no deterministas (`CA2`), implementando aritmética de fechas exacta en TypeScript dentro de `src/tools/contratos.ts`.

---

## 11. Riesgos en producción y mitigación

1. **PDFs escaneados como imagen sin capa de texto**: *Mitigación*: Añadir un paso previo de OCR antes de `contratos_extraer` y marcar confianza `< 0.8` si la calidad OCR es baja.
2. **Variaciones en el nombre del cliente (ej. "S.A.S." vs "SAS")**: *Mitigación*: La deduplicación prioriza `nit_cliente` normalizado (sin puntos ni dígito de verificación) y normaliza slugs de carpetas.
3. **Consumo excesivo de API por bucles o prompts largos**: *Mitigación*: Guardrails estrictos de `MAX_ITERATIONS=25`, `MAX_SESSION_TOKENS` y `LLM_TIMEOUT_MS` en el backend.
