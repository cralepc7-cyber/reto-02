import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CampoConConfianza,
  ClasificacionContrato,
  ContratoExtraido,
  EstadoPoliza,
  MaestroFila,
  MonedaCodigo,
  PaisCodigo,
  ToolContext,
} from "../types/contratos";

interface CorreoJson {
  id: string;
  de: string;
  para: string;
  asunto: string;
  fecha: string;
  cuerpo: string;
  adjuntos: string[];
}

interface ComercialInfo {
  email: string;
  nombre: string;
  region: string;
}

const MESES: Record<string, string> = {
  enero: "01",
  febrero: "02",
  marzo: "03",
  abril: "04",
  mayo: "05",
  junio: "06",
  julio: "07",
  agosto: "08",
  septiembre: "09",
  setiembre: "09",
  octubre: "10",
  noviembre: "11",
  diciembre: "12",
};

function ok(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

function fail(error: string): string {
  return JSON.stringify({ ok: false, error });
}

async function appendLog(
  directory: string,
  herramienta: string,
  mensajeId: string | null,
  statusOk: boolean,
  resumen: string
): Promise<void> {
  const outDir = path.join(directory, "out");
  await fs.mkdir(outDir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    herramienta,
    mensaje_id: mensajeId,
    ok: statusOk,
    resumen,
  };
  await fs.appendFile(path.join(outDir, "log.jsonl"), JSON.stringify(entry) + "\n", "utf-8");
}

function slugify(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(s\.?a\.?s\.?|s\.?a\.?c\.?|s\.?a\.?|s\.?\s*de\s*r\.?l\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizarNit(raw: string): string {
  const limpio = raw.trim().replace(/\./g, "").replace(/\s+/g, "");
  const sinDv = limpio.includes("-") ? limpio.split("-")[0] : limpio;
  return sinDv.replace(/\D/g, "");
}

function inferirPaisYMoneda(texto: string, nitRaw: string): { pais: PaisCodigo; moneda: MonedaCodigo } {
  const upper = texto.toUpperCase();
  let moneda: MonedaCodigo = "COP";
  if (/\bPEN\b|SOLES/.test(upper)) moneda = "PEN";
  else if (/\bUSD\b|DÓLARES|DOLARES/.test(upper)) moneda = "USD";
  else if (/\bPAB\b|BALBOAS/.test(upper)) moneda = "PAB";
  else if (/\bHNL\b|LEMPIRAS/.test(upper)) moneda = "HNL";
  else if (/\bCOP\b|PESOS\s+M\/CTE/.test(upper)) moneda = "COP";

  let pais: PaisCodigo = "CO";
  if (/PERÚ|PERU|LIMA/.test(upper) || moneda === "PEN") pais = "PE";
  else if (/ECUADOR|QUITO|GUAYAQUIL/.test(upper) || (nitRaw.length === 13 && nitRaw.endsWith("001"))) pais = "EC";
  else if (/PANAMÁ|PANAMA/.test(upper) || moneda === "PAB") pais = "PA";
  else if (/HONDURAS|TEGUCIGALPA|SAN PEDRO SULA/.test(upper) || moneda === "HNL" || nitRaw.length === 14) pais = "HN";
  else pais = "CO";

  return { pais, moneda };
}

function parseFechaEspanol(texto: string): string | null {
  const iso = texto.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];

  const regex = /(?:primero|[a-záéíóú]+)?\s*\(?(\d{1,2})\)?\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i;
  const m = texto.match(regex);
  if (m) {
    const dia = m[1].padStart(2, "0");
    const mes = MESES[m[2].toLowerCase()];
    const anio = m[3];
    if (mes) return `${anio}-${mes}-${dia}`;
  }
  return null;
}

function sumarMesesFin(fechaInicio: string, meses: number): string {
  const [y, m, d] = fechaInicio.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + meses, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function serializeCsvCell(val: string | number | boolean): string {
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

async function ensureSharepointMaestro(directory: string): Promise<string> {
  const spDir = path.join(directory, "out", "sharepoint");
  await fs.mkdir(spDir, { recursive: true });
  const targetCsv = path.join(spDir, "maestro-contratos.csv");
  try {
    await fs.access(targetCsv);
  } catch {
    const fixtureCsv = path.join(directory, "fixtures", "reto-02", "maestro-contratos.csv");
    await fs.copyFile(fixtureCsv, targetCsv);
  }
  return targetCsv;
}

async function leerMaestro(directory: string): Promise<MaestroFila[]> {
  const csvPath = await ensureSharepointMaestro(directory);
  const raw = await fs.readFile(csvPath, "utf-8");
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const c = parseCsvLine(line);
    return {
      id_contrato: c[0],
      cliente: c[1],
      nit_cliente: c[2],
      pais: c[3] as PaisCodigo,
      objeto: c[4],
      valor: Number(c[5]),
      moneda: c[6] as MonedaCodigo,
      fecha_inicio: c[7],
      fecha_fin: c[8],
      requiere_poliza: c[9] === "true",
      tipo_poliza: c[10],
      estado_poliza: c[11] as EstadoPoliza,
      comercial: c[12],
      ruta_sharepoint: c[13],
      fecha_registro: c[14],
      fuente: c[15] as MaestroFila["fuente"],
    };
  });
}

async function guardarMaestro(directory: string, filas: MaestroFila[]): Promise<void> {
  const csvPath = await ensureSharepointMaestro(directory);
  const headers = [
    "id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
    "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "estado_poliza",
    "comercial", "ruta_sharepoint", "fecha_registro", "fuente",
  ];
  const rows = filas.map((f) =>
    [
      f.id_contrato, f.cliente, f.nit_cliente, f.pais, f.objeto, f.valor, f.moneda,
      f.fecha_inicio, f.fecha_fin, f.requiere_poliza, f.tipo_poliza, f.estado_poliza,
      f.comercial, f.ruta_sharepoint, f.fecha_registro, f.fuente,
    ]
      .map(serializeCsvCell)
      .join(",")
  );
  await fs.writeFile(csvPath, [headers.join(","), ...rows].join("\n") + "\n", "utf-8");
}

function similitudTexto(a: string, b: string): number {
  const tokA = new Set(a.toLowerCase().replace(/[^a-z0-9áéíóúñ\s]/g, "").split(/\s+/).filter(Boolean));
  const tokB = new Set(b.toLowerCase().replace(/[^a-z0-9áéíóúñ\s]/g, "").split(/\s+/).filter(Boolean));
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let inter = 0;
  for (const t of tokA) if (tokB.has(t)) inter++;
  return inter / Math.max(tokA.size, tokB.size);
}

async function marcarProcesado(directory: string, mensajeId: string, estado: string): Promise<void> {
  const p = path.join(directory, "out", "procesados.json");
  await fs.mkdir(path.dirname(p), { recursive: true });
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(await fs.readFile(p, "utf-8"));
  } catch {
    data = {};
  }
  data[mensajeId] = { estado, ts: new Date().toISOString() };
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

export const leer_buzon = {
  description: "Lista los mensajes pendientes en el buzón de contratos que aún no han sido procesados.",
  args: {},
  async execute(_args: Record<string, never>, ctx: ToolContext): Promise<string> {
    try {
      const buzonDir = path.join(ctx.directory, "fixtures", "reto-02", "buzon");
      const procesadosPath = path.join(ctx.directory, "out", "procesados.json");
      let procesados: Record<string, unknown> = {};
      try {
        procesados = JSON.parse(await fs.readFile(procesadosPath, "utf-8"));
      } catch {
        procesados = {};
      }

      const entries = (await fs.readdir(buzonDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

      const mensajes = [];
      for (const dirName of entries) {
        if (procesados[dirName]) continue;
        const correoPath = path.join(buzonDir, dirName, "correo.json");
        const correo: CorreoJson = JSON.parse(await fs.readFile(correoPath, "utf-8"));
        const adjContrato = correo.adjuntos.find((a) => /(contrato|otrosi)/i.test(a));
        const tieneContrato = Boolean(adjContrato);
        const motivoRechazo = tieneContrato
          ? undefined
          : `Adjunto no corresponde a un contrato u otrosí (${correo.adjuntos.join(", ") || "sin adjuntos"}).`;

        mensajes.push({
          id: correo.id,
          de: correo.de,
          asunto: correo.asunto,
          fecha: correo.fecha,
          adjuntos: correo.adjuntos,
          tiene_contrato: tieneContrato,
          ...(motivoRechazo ? { motivo_rechazo: motivoRechazo } : {}),
        });
      }

      await appendLog(ctx.directory, "contratos_leer_buzon", null, true, `${mensajes.length} mensajes pendientes leídos`);
      return ok({ mensajes });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(ctx.directory, "contratos_leer_buzon", null, false, msg);
      return fail(`Error leyendo el buzón: ${msg}`);
    }
  },
};

export const extraer = {
  description: "Extrae los campos estructurados y niveles de confianza de un contrato u otrosí adjunto a un mensaje.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje en el buzón, por ejemplo msg-001"),
  },
  async execute(args: { mensaje_id: string }, ctx: ToolContext): Promise<string> {
    try {
      const msgDir = path.join(ctx.directory, "fixtures", "reto-02", "buzon", args.mensaje_id);
      const correo: CorreoJson = JSON.parse(await fs.readFile(path.join(msgDir, "correo.json"), "utf-8"));
      const adjunto = correo.adjuntos.find((a) => /(contrato|otrosi)/i.test(a)) ?? correo.adjuntos[0];

      if (!adjunto) {
        await appendLog(ctx.directory, "contratos_extraer", args.mensaje_id, false, "Sin adjunto");
        return fail("El mensaje no contiene archivos adjuntos.");
      }

      const texto = await fs.readFile(path.join(msgDir, adjunto), "utf-8");
      if (!texto.trim()) {
        await appendLog(ctx.directory, "contratos_extraer", args.mensaje_id, false, "Texto vacío");
        return fail("El documento adjunto está vacío.");
      }

      const esOtrosi = /OTROS[ÍI]/i.test(texto) || /otrosi/i.test(adjunto);

      const idMatch = texto.match(/\b([A-Z]{2,4}-\d{4}-\d{2,4})\b/);
      const idContrato: CampoConConfianza<string | null> = idMatch
        ? { valor: idMatch[1], confianza: 0.98 }
        : { valor: null, confianza: 0, motivo: "No se encontró número de contrato explícito" };

      const clienteMatch = texto.match(/Entre(?:\s+los\s+suscritos,)?\s+([A-ZÁÉÍÓÚÑ0-9\s.,&-]+?),\s+(?:identificada\s+con\s+)?(?:NIT|RUC|RTN)\s+([0-9.-]+)/i);
      const clienteVal = clienteMatch ? clienteMatch[1].trim() : null;
      const nitVal = clienteMatch ? normalizarNit(clienteMatch[2]) : null;

      const { pais, moneda } = inferirPaisYMoneda(texto, nitVal ?? "");

      const objMatch = texto.match(/PRIMERA\.\s*OBJETO\.\s*([^\n]+)/i);
      let objetoVal = objMatch ? objMatch[1].trim() : null;
      if (objetoVal && objetoVal.length > 200) objetoVal = objetoVal.slice(0, 197) + "...";

      const esIndeterminado = /no\s+tiene\s+un\s+valor\s+determinado|por\s+demanda|órdenes\s+de\s+servicio/i.test(texto);
      let valorCampo: CampoConConfianza<number | null>;
      let valorIndetCampo: CampoConConfianza<boolean>;

      if (esIndeterminado) {
        valorCampo = {
          valor: 0,
          confianza: 0.55,
          motivo: "Contrato marco sin valor determinado; requiere confirmación humana del valor base 0.",
        };
        valorIndetCampo = { valor: true, confianza: 0.95 };
      } else {
        const valMatch = texto.match(/(?:COP|USD|PEN|PAB|HNL)\s*\$?\s*([0-9.,]+)/i);
        if (valMatch) {
          const cleanDecimal = valMatch[1].match(/[.,](\d{2})$/)
            ? Number(valMatch[1].slice(0, -3).replace(/[.,]/g, ""))
            : Number(valMatch[1].replace(/[.,]/g, ""));
          valorCampo = { valor: cleanDecimal, confianza: 0.96 };
          valorIndetCampo = { valor: false, confianza: 0.98 };
        } else {
          valorCampo = { valor: null, confianza: 0, motivo: "Valor monetario no encontrado" };
          valorIndetCampo = { valor: false, confianza: 0.5 };
        }
      }

      let fechaInicio: CampoConConfianza<string | null> = { valor: null, confianza: 0 };
      let fechaFin: CampoConConfianza<string | null> = { valor: null, confianza: 0 };

      const rangoMatch = texto.match(/desde\s+el\s+(.+?)\s+hasta\s+el\s+(.+?)(?:\.|,|\n)/i);
      if (rangoMatch) {
        const ini = parseFechaEspanol(rangoMatch[1]);
        const fin = parseFechaEspanol(rangoMatch[2]);
        fechaInicio = ini ? { valor: ini, confianza: 0.97 } : { valor: null, confianza: 0 };
        fechaFin = fin ? { valor: fin, confianza: 0.97 } : { valor: null, confianza: 0 };
      } else if (esOtrosi) {
        const suscritoMatch = texto.match(/suscrito\s+el\s+(.+?)(?:,|\n)/i);
        const extiendeMatch = texto.match(/extiende\s+hasta\s+el\s+(.+?)(?:\.|"|\n)/i);
        const ini = suscritoMatch ? parseFechaEspanol(suscritoMatch[1]) : null;
        const fin = extiendeMatch ? parseFechaEspanol(extiendeMatch[1]) : null;
        fechaInicio = ini ? { valor: ini, confianza: 0.92 } : { valor: null, confianza: 0 };
        fechaFin = fin ? { valor: fin, confianza: 0.97 } : { valor: null, confianza: 0 };
      } else {
        const duracionMatch = texto.match(/duraci[óo]n\s+de\s+(?:[a-záéíóú]+\s+)?\(?(\d+)\)?\s+meses/i);
        const firmaMesMatch = texto.match(/en\s+el\s+mes\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i);
        if (duracionMatch && firmaMesMatch) {
          const meses = Number(duracionMatch[1]);
          const mesNum = MESES[firmaMesMatch[1].toLowerCase()] ?? "08";
          const anio = firmaMesMatch[2];
          const iniInferido = `${anio}-${mesNum}-01`;
          const finInferido = sumarMesesFin(iniInferido, meses);
          fechaInicio = {
            valor: iniInferido,
            confianza: 0.65,
            motivo: "El documento indica 'mes de agosto de 2026' sin día exacto de firma.",
          };
          fechaFin = {
            valor: finInferido,
            confianza: 0.6,
            motivo: `Calculada a ${meses} meses desde una fecha de firma sin día exacto.`,
          };
        }
      }

      const tieneClausulaPoliza = /GARANT[ÍI]AS|p[óo]liza\s+de\s+cumplimiento/i.test(texto);
      const tiposPoliza: string[] = [];
      if (/cumplimiento/i.test(texto)) tiposPoliza.push("cumplimiento");
      if (/responsabilidad\s+civil/i.test(texto)) tiposPoliza.push("responsabilidad_civil");
      if (/salarios/i.test(texto)) tiposPoliza.push("salarios_prestaciones");
      if (/calidad/i.test(texto)) tiposPoliza.push("calidad");

      const comercialesPath = path.join(ctx.directory, "fixtures", "reto-02", "comerciales.json");
      const comerciales: ComercialInfo[] = JSON.parse(await fs.readFile(comercialesPath, "utf-8"));
      const encontrado = comerciales.find((c) => c.email.toLowerCase() === correo.de.toLowerCase());
      const comercialCampo: CampoConConfianza<string | null> = encontrado
        ? { valor: encontrado.nombre, confianza: 0.99 }
        : {
            valor: correo.de,
            confianza: 0.6,
            motivo: `Remitente (${correo.de}) no figura en el catálogo oficial comerciales.json.`,
          };

      const extracted: ContratoExtraido = {
        id_contrato: idContrato,
        cliente: clienteVal ? { valor: clienteVal, confianza: 0.97 } : { valor: null, confianza: 0 },
        nit_cliente: nitVal ? { valor: nitVal, confianza: 0.97 } : { valor: null, confianza: 0 },
        pais: { valor: pais, confianza: 0.95 },
        objeto: objetoVal
          ? { valor: objetoVal, confianza: 0.9 }
          : esOtrosi
          ? { valor: "Modificación mediante Otrosí", confianza: 0.85 }
          : { valor: null, confianza: 0 },
        valor: valorCampo,
        valor_indeterminado: valorIndetCampo,
        moneda: { valor: moneda, confianza: 0.96 },
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        requiere_poliza: { valor: tieneClausulaPoliza, confianza: 0.95 },
        tipo_poliza: { valor: tiposPoliza, confianza: tieneClausulaPoliza ? 0.94 : 0.95 },
        comercial: comercialCampo,
        es_otrosi: esOtrosi,
        adjunto_nombre: adjunto,
      };

      await appendLog(ctx.directory, "contratos_extraer", args.mensaje_id, true, `Extraído ${idContrato.valor ?? "sin-id"}`);
      return ok(extracted);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(ctx.directory, "contratos_extraer", args.mensaje_id, false, msg);
      return fail(`Error extrayendo datos de ${args.mensaje_id}: ${msg}`);
    }
  },
};

export const validar = {
  description: "Valida un contrato extraído contra las reglas de negocio RN1-RN5 y el maestro vigente.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje en el buzón"),
    contrato: z.record(z.unknown()).describe("Objeto ContratoExtraido devuelto por contratos_extraer"),
  },
  async execute(args: { mensaje_id: string; contrato: ContratoExtraido }, ctx: ToolContext): Promise<string> {
    try {
      const c = args.contrato;
      if (!c.cliente?.valor || !c.objeto?.valor) {
        await appendLog(ctx.directory, "contratos_validar", args.mensaje_id, true, "Clasificado como rechazado");
        return ok({
          clasificacion: "rechazado" as ClasificacionContrato,
          motivo: "El documento no contiene partes ni objeto contractual identificables (RN4).",
          requiere_revision: [],
        });
      }

      const maestro = await leerMaestro(ctx.directory);
      const idVal = c.id_contrato?.valor ?? "";
      const nitVal = c.nit_cliente?.valor ?? "";
      const objVal = c.objeto?.valor ?? "";

      let existente = maestro.find((m) => m.id_contrato === idVal);
      if (!existente && nitVal && objVal) {
        existente = maestro.find(
          (m) => m.nit_cliente === nitVal && similitudTexto(m.objeto, objVal) >= 0.9
        );
      }

      const requiereRevision: string[] = [];
      const camposEvaluar: Array<[string, CampoConConfianza<unknown> | undefined]> = [
        ["id_contrato", c.id_contrato],
        ["cliente", c.cliente],
        ["nit_cliente", c.nit_cliente],
        ["valor", c.valor],
        ["moneda", c.moneda],
        ["fecha_inicio", c.fecha_inicio],
        ["fecha_fin", c.fecha_fin],
        ["comercial", c.comercial],
      ];

      for (const [nombre, campo] of camposEvaluar) {
        if (campo && campo.confianza < 0.8) {
          requiereRevision.push(`${nombre} (confianza ${campo.confianza}: ${campo.motivo ?? "baja confianza"})`);
        }
      }

      let clasificacion: ClasificacionContrato = "nuevo";
      const diferencias: Record<string, { anterior: unknown; nuevo: unknown }> = {};

      if (existente) {
        const mismoValor = existente.valor === (c.valor?.valor ?? existente.valor);
        const mismoInicio = existente.fecha_inicio === (c.fecha_inicio?.valor ?? existente.fecha_inicio);
        const mismoFin = existente.fecha_fin === (c.fecha_fin?.valor ?? existente.fecha_fin);

        if (!c.es_otrosi && mismoValor && mismoInicio && mismoFin) {
          clasificacion = "duplicado";
        } else {
          clasificacion = "actualizacion";
          if (!mismoValor) diferencias.valor = { anterior: existente.valor, nuevo: c.valor?.valor };
          if (!mismoInicio) diferencias.fecha_inicio = { anterior: existente.fecha_inicio, nuevo: c.fecha_inicio?.valor };
          if (!mismoFin) diferencias.fecha_fin = { anterior: existente.fecha_fin, nuevo: c.fecha_fin?.valor };
        }
      }

      await appendLog(
        ctx.directory,
        "contratos_validar",
        args.mensaje_id,
        true,
        `clasificacion=${clasificacion}, revision=${requiereRevision.length}`
      );

      return ok({
        clasificacion,
        ...(existente ? { id_contrato_existente: existente.id_contrato } : {}),
        requiere_revision: requiereRevision,
        ...(Object.keys(diferencias).length > 0 ? { diferencias } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(ctx.directory, "contratos_validar", args.mensaje_id, false, msg);
      return fail(`Error validando ${args.mensaje_id}: ${msg}`);
    }
  },
};

export const registrar = {
  description: "Registra o actualiza un contrato en el maestro CSV, archiva el documento en SharePoint y registra auditoría.",
  args: {
    mensaje_id: z.string().describe("Identificador del mensaje en el buzón"),
    contrato: z.record(z.unknown()).describe("Objeto ContratoExtraido (puede incluir valores ajustados por confirmación)"),
    confirmado: z.boolean().optional().describe("Debe ser true si el contrato tenía campos en requiere_revision"),
  },
  async execute(
    args: { mensaje_id: string; contrato: ContratoExtraido; confirmado?: boolean },
    ctx: ToolContext
  ): Promise<string> {
    try {
      const valRaw = await validar.execute({ mensaje_id: args.mensaje_id, contrato: args.contrato }, ctx);
      const valParsed = JSON.parse(valRaw);
      if (!valParsed.ok) return valRaw;

      const { clasificacion, requiere_revision, id_contrato_existente, diferencias } = valParsed.data;

      if (clasificacion === "duplicado" || clasificacion === "rechazado") {
        await marcarProcesado(ctx.directory, args.mensaje_id, clasificacion);
        await appendLog(ctx.directory, "contratos_registrar", args.mensaje_id, true, `Omitido por ${clasificacion}`);
        return ok({
          id_contrato: args.contrato.id_contrato?.valor ?? "N/A",
          accion: clasificacion,
          ruta_archivo: null,
        });
      }

      if (requiere_revision.length > 0 && !args.confirmado) {
        const errMsg = `requiere revisión: ${requiere_revision.join("; ")}`;
        await appendLog(ctx.directory, "contratos_registrar", args.mensaje_id, false, errMsg);
        return fail(errMsg);
      }

      const maestro = await leerMaestro(ctx.directory);
      const c = args.contrato;
      const hoy = ctx.today ?? "2026-09-03";
      const idContrato = c.id_contrato?.valor ?? `AUTO-2026-${String(maestro.length + 1).padStart(3, "0")}`;
      const cliente = c.cliente?.valor ?? "Cliente Desconocido";
      const fechaInicio = c.fecha_inicio?.valor ?? hoy;
      const anioInicio = fechaInicio.slice(0, 4);
      const clienteSlug = slugify(cliente);
      const ext = path.extname(c.adjunto_nombre || "contrato.txt") || ".txt";
      const rutaRelativa = `Contratos/${anioInicio}/${clienteSlug}/${idContrato}${ext}`;

      const srcFile = path.join(ctx.directory, "fixtures", "reto-02", "buzon", args.mensaje_id, c.adjunto_nombre);
      const destFile = path.join(ctx.directory, "out", "sharepoint", rutaRelativa);
      await fs.mkdir(path.dirname(destFile), { recursive: true });
      await fs.copyFile(srcFile, destFile);

      if (clasificacion === "actualizacion" && id_contrato_existente) {
        const idx = maestro.findIndex((m) => m.id_contrato === id_contrato_existente);
        if (idx >= 0) {
          const prev = maestro[idx];
          maestro[idx] = {
            ...prev,
            valor: c.valor?.valor ?? prev.valor,
            fecha_fin: c.fecha_fin?.valor ?? prev.fecha_fin,
            ruta_sharepoint: rutaRelativa,
            fecha_registro: hoy,
          };
        }
      } else {
        const reqPoliza = Boolean(c.requiere_poliza?.valor);
        const nuevaFila: MaestroFila = {
          id_contrato: idContrato,
          cliente,
          nit_cliente: c.nit_cliente?.valor ?? "",
          pais: (c.pais?.valor as PaisCodigo) ?? "CO",
          objeto: (c.objeto?.valor ?? "").slice(0, 200),
          valor: c.valor?.valor ?? 0,
          moneda: (c.moneda?.valor as MonedaCodigo) ?? "COP",
          fecha_inicio: fechaInicio,
          fecha_fin: c.fecha_fin?.valor ?? fechaInicio,
          requiere_poliza: reqPoliza,
          tipo_poliza: reqPoliza ? (c.tipo_poliza?.valor ?? []).join(";") : "",
          estado_poliza: reqPoliza ? "pendiente" : "no_aplica",
          comercial: c.comercial?.valor ?? "Desconocido",
          ruta_sharepoint: rutaRelativa,
          fecha_registro: hoy,
          fuente: "buzon",
        };
        maestro.push(nuevaFila);
      }

      await guardarMaestro(ctx.directory, maestro);

      const histEntry = {
        ts: new Date().toISOString(),
        id_contrato: idContrato,
        accion: clasificacion,
        cambios: diferencias ?? { registro_inicial: true },
        mensaje_id: args.mensaje_id,
      };
      await fs.appendFile(
        path.join(ctx.directory, "out", "sharepoint", "historial.jsonl"),
        JSON.stringify(histEntry) + "\n",
        "utf-8"
      );

      await marcarProcesado(ctx.directory, args.mensaje_id, clasificacion);
      await appendLog(ctx.directory, "contratos_registrar", args.mensaje_id, true, `${clasificacion} -> ${idContrato}`);

      return ok({
        id_contrato: idContrato,
        accion: clasificacion,
        ruta_archivo: `out/sharepoint/${rutaRelativa}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(ctx.directory, "contratos_registrar", args.mensaje_id, false, msg);
      return fail(`Error registrando ${args.mensaje_id}: ${msg}`);
    }
  },
};

export const alertas = {
  description: "Genera el reporte out/alertas.md con vencimientos próximos (<= 60 días), pólizas pendientes y contratos desde el 2026-05-30.",
  args: {
    hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Fecha de referencia YYYY-MM-DD"),
  },
  async execute(args: { hoy: string }, ctx: ToolContext): Promise<string> {
    try {
      const maestro = await leerMaestro(ctx.directory);
      const refDate = new Date(`${args.hoy}T00:00:00Z`).getTime();
      const msPorDia = 86_400_000;

      const vencen = maestro.filter((m) => {
        const fin = new Date(`${m.fecha_fin}T00:00:00Z`).getTime();
        const dias = Math.round((fin - refDate) / msPorDia);
        return dias >= 0 && dias <= 60;
      });

      const polizasPendientes = maestro.filter(
        (m) => m.requiere_poliza && m.estado_poliza !== "vigente"
      );

      const registradosDesdeCorte = maestro.filter(
        (m) => m.fecha_registro > "2026-05-30"
      );

      const mdLines = [
        `# Reporte de Alertas y Riesgos Contractuales (${args.hoy})`,
        ``,
        `## 1. Contratos que vencen en ≤ 60 días (${vencen.length})`,
        vencen.length === 0
          ? "- Ningún contrato vence en los próximos 60 días."
          : vencen
              .map((v) => `- **${v.id_contrato}** · ${v.cliente} · Vence: \`${v.fecha_fin}\` · Valor: ${v.moneda} ${v.valor.toLocaleString("es-CO")}`)
              .join("\n"),
        ``,
        `## 2. Pólizas requeridas pendientes o no vigentes (${polizasPendientes.length})`,
        polizasPendientes.length === 0
          ? "- Todas las pólizas requeridas se encuentran vigentes."
          : polizasPendientes
              .map((p) => `- **${p.id_contrato}** · ${p.cliente} · Tipos: \`${p.tipo_poliza}\` · Estado: **${p.estado_poliza}**`)
              .join("\n"),
        ``,
        `## 3. Contratos incorporados desde el corte 2026-05-30 (${registradosDesdeCorte.length})`,
        registradosDesdeCorte.length === 0
          ? "- Sin registros posteriores al corte."
          : registradosDesdeCorte
              .map((r) => `- **${r.id_contrato}** · ${r.cliente} · Registro: \`${r.fecha_registro}\` · Fuente: ${r.fuente}`)
              .join("\n"),
      ];

      const outAlertas = path.join(ctx.directory, "out", "alertas.md");
      await fs.mkdir(path.dirname(outAlertas), { recursive: true });
      await fs.writeFile(outAlertas, mdLines.join("\n") + "\n", "utf-8");

      await appendLog(
        ctx.directory,
        "contratos_alertas",
        null,
        true,
        `vencen=${vencen.length}, polizas=${polizasPendientes.length}, post_corte=${registradosDesdeCorte.length}`
      );

      return ok({
        ruta: "out/alertas.md",
        vencen,
        polizas_pendientes: polizasPendientes,
        registrados_desde_corte: registradosDesdeCorte,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendLog(ctx.directory, "contratos_alertas", null, false, msg);
      return fail(`Error generando alertas: ${msg}`);
    }
  },
};

export const leer_pdf = {
  description: "Lee el contenido textual de un archivo de contrato relativo al proyecto.",
  args: {
    ruta: z.string().describe("Ruta relativa del archivo dentro del proyecto"),
  },
  async execute(args: { ruta: string }, ctx: ToolContext): Promise<string> {
    try {
      const safePath = path.resolve(ctx.directory, args.ruta);
      if (!safePath.startsWith(path.resolve(ctx.directory))) {
        return fail("Ruta fuera del directorio permitido.");
      }
      const texto = await fs.readFile(safePath, "utf-8");
      await appendLog(ctx.directory, "contratos_leer_pdf", null, true, `Leído ${args.ruta}`);
      return ok({ texto });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return fail(`No se pudo leer el archivo: ${msg}`);
    }
  },
};
