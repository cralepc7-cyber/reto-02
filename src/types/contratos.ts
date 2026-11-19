export type PaisCodigo = "CO" | "EC" | "PE" | "PA" | "HN";
export type MonedaCodigo = "COP" | "USD" | "PEN" | "PAB" | "HNL";
export type EstadoPoliza = "vigente" | "pendiente" | "vencida" | "no_aplica";
export type FuenteRegistro = "buzon" | "manual" | "migracion";
export type ClasificacionContrato = "nuevo" | "actualizacion" | "duplicado" | "rechazado";

export interface CampoConConfianza<T> {
  valor: T;
  confianza: number; // [0, 1]
  motivo?: string;
}

export interface ContratoExtraido {
  id_contrato: CampoConConfianza<string | null>;
  cliente: CampoConConfianza<string | null>;
  nit_cliente: CampoConConfianza<string | null>;
  pais: CampoConConfianza<PaisCodigo | null>;
  objeto: CampoConConfianza<string | null>;
  valor: CampoConConfianza<number | null>;
  valor_indeterminado: CampoConConfianza<boolean>;
  moneda: CampoConConfianza<MonedaCodigo | null>;
  fecha_inicio: CampoConConfianza<string | null>;
  fecha_fin: CampoConConfianza<string | null>;
  requiere_poliza: CampoConConfianza<boolean>;
  tipo_poliza: CampoConConfianza<string[]>;
  comercial: CampoConConfianza<string | null>;
  es_otrosi: boolean;
  adjunto_nombre: string;
}

export interface MaestroFila {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: PaisCodigo;
  objeto: string;
  valor: number;
  moneda: MonedaCodigo;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: boolean;
  tipo_poliza: string;
  estado_poliza: EstadoPoliza;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: FuenteRegistro;
}

export interface ToolContext {
  directory: string;
  sessionId: string;
  today?: string;
}
