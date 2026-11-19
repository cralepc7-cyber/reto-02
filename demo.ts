import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as contratos from "./src/tools/contratos";

const ROOT = process.cwd();
const HOY = "2026-09-03";
const ctx = { directory: ROOT, sessionId: "demo-session", today: HOY };

async function main() {
  await fs.rm(path.join(ROOT, "out"), { recursive: true, force: true });

  console.log("=== 1. LEYENDO BUZÓN DE CONTRATOS ===");
  const buzonRes = JSON.parse(await contratos.leer_buzon.execute({}, ctx));
  const mensajes = buzonRes.data.mensajes;
  console.log(`Mensajes pendientes encontrados: ${mensajes.length}\n`);

  let msgPendienteConfirmacion: { id: string; contrato: Record<string, unknown> } | null = null;

  for (const m of mensajes) {
    console.log(`--- Procesando ${m.id} (${m.asunto}) ---`);
    if (!m.tiene_contrato) {
      console.log(`Clasificación: rechazado | Motivo: ${m.motivo_rechazo}\n`);
      continue;
    }

    const extRes = JSON.parse(await contratos.extraer.execute({ mensaje_id: m.id }, ctx));
    const valRes = JSON.parse(await contratos.validar.execute({ mensaje_id: m.id, contrato: extRes.data }, ctx));
    const { clasificacion, requiere_revision } = valRes.data;

    console.log(`Clasificación: ${clasificacion}`);
    console.log(`Campos en revisión: ${requiere_revision.length ? requiere_revision.join(" | ") : "Ninguno"}`);

    const regRes = JSON.parse(await contratos.registrar.execute({ mensaje_id: m.id, contrato: extRes.data }, ctx));
    if (regRes.ok) {
      console.log(`Acción tomada: ${regRes.data.accion} -> ${regRes.data.ruta_archivo ?? "sin escritura"}\n`);
    } else {
      console.log(`Acción bloqueada (esperado): ${regRes.error}\n`);
      msgPendienteConfirmacion = { id: m.id, contrato: extRes.data };
    }
  }

  if (msgPendienteConfirmacion) {
    console.log(`=== 2. SEGUNDA PASADA CON CONFIRMACIÓN HUMANA (${msgPendienteConfirmacion.id}) ===`);
    const contratoConfirmado = {
      ...msgPendienteConfirmacion.contrato,
      valor: { valor: 0, confianza: 1 },
      fecha_inicio: { valor: "2026-08-31", confianza: 1 },
      fecha_fin: { valor: "2027-08-31", confianza: 1 },
    };
    const confirmRes = JSON.parse(
      await contratos.registrar.execute(
        {
          mensaje_id: msgPendienteConfirmacion.id,
          contrato: contratoConfirmado as never,
          confirmado: true,
        },
        ctx
      )
    );
    console.log("Resultado tras confirmación:", confirmRes.data, "\n");
  }

  console.log("=== 3. GENERANDO REPORTE DE ALERTAS ===");
  const alertasRes = JSON.parse(await contratos.alertas.execute({ hoy: HOY }, ctx));
  console.log(`Reporte generado en: ${alertasRes.data.ruta}`);
  console.log(`- Vencen <= 60 días: ${alertasRes.data.vencen.length}`);
  console.log(`- Pólizas pendientes: ${alertasRes.data.polizas_pendientes.length}`);
  console.log(`- Incorporados post-corte (2026-05-30): ${alertasRes.data.registrados_desde_corte.length}`);
}

main();
