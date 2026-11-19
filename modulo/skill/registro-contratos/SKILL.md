---
name: registro-contratos
description: Reglas de negocio (RN1-RN7), normalización tributaria y criterios de alertas para el registro maestro de contratos vigentes de Periferia IT Group.
---

# Base de Conocimiento: Proceso de Registro de Contratos Vigentes (Periferia IT Group)

## 1. Contexto Operativo
- **Corte histórico**: El archivo maestro (`maestro-contratos.csv`) quedó congelado el **2026-05-30**.
- **Alcance**: Todo contrato u otrosí recibido en el buzón único debe clasificarse y, si aplica, registrarse en el maestro y archivarse en la estructura SharePoint (`Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`), independientemente de si exige o no póliza.

## 2. Reglas de Clasificación y Negocio (RN1 – RN7)
- **RN1 · Duplicado**: Coincide `id_contrato` con el maestro y mantiene idénticos `valor`, `fecha_inicio` y `fecha_fin`. No modifica el maestro ni genera historial; se informa al usuario.
- **RN2 · Actualización**: Coincide `id_contrato` (o `nit_cliente` + similitud de `objeto` ≥ 0.90) con cambios en vigencia, valor u otros campos, o el documento corresponde a un **Otrosí**. Actualiza la fila existente en `maestro-contratos.csv` y añade una entrada de auditoría en `out/sharepoint/historial.jsonl`.
- **RN3 · Nuevo**: No existe coincidencia previa en el maestro. Inserta una nueva fila con `fecha_registro` igual a la fecha de procesamiento y `fuente = "buzon"`. Si `requiere_poliza = true`, su `estado_poliza` inicial es `"pendiente"`; si `requiere_poliza = false`, su `estado_poliza` es `"no_aplica"`.
- **RN4 · Rechazado**: El correo no adjunta un contrato u otrosí (ej. cotizaciones, consultas comerciales) o el documento carece de partes y objeto identificables.
- **RN5 · Umbral de Confianza (< 0.80)**: Cualquier campo con confianza inferior a `0.80` (por ejemplo, contratos marco de valor indeterminado, fechas sin día exacto de firma o remitentes no catalogados en `comerciales.json`) bloquea el registro automático y se incluye en `requiere_revision`. Solo puede registrarse tras confirmación explícita del analista (`confirmado: true`).
- **RN6 · Inmutabilidad de Fixtures**: `fixtures/reto-02/maestro-contratos.csv` nunca se modifica. En la primera ejecución se copia hacia `out/sharepoint/maestro-contratos.csv`.
- **RN7 · Trazabilidad**: Cada invocación de herramienta escribe un registro en `out/log.jsonl`.

## 3. Normalización de Países, Monedas e Identificadores
- **NIT / RUC / RTN (`nit_cliente`)**: Se almacena sin puntos, espacios, guiones ni dígito de verificación (ej. `890.900.111-4` → `890900111`).
- **Países y Monedas**:
  - Colombia (`CO`) → `COP` (NIT de 9 dígitos)
  - Panamá (`PA`) → `PAB` o `USD` (RUC)
  - Ecuador (`EC`) → `USD` (RUC de 13 dígitos terminado en `001`)
  - Perú (`PE`) → `PEN` o `USD` (RUC de 11 dígitos empezando por `20` o `10`)
  - Honduras (`HN`) → `HNL` o `USD` (RTN de 14 dígitos)

## 4. Criterios de Alertas Gerenciales
1. **Vencimientos próximos (≤ 60 días)**: Contratos vigentes cuya `fecha_fin` ocurre entre `hoy` y `hoy + 60 días`.
2. **Pólizas pendientes o no vigentes**: Todo contrato con `requiere_poliza = true` cuyo `estado_poliza` sea distinto de `vigente` (`pendiente` o `vencida`).
3. **Cierre de brecha (post 2026-05-30)**: Contratos incorporados o actualizados con `fecha_registro > 2026-05-30`.
