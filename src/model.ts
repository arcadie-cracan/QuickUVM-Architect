// The project-model types — the TypeScript mirror of the
// schema/project-model.schema.json contract (schema_version 1). Semantics:
// docs/02-model-de-proiect.md. Any change here must originate
// from the schema, not the other way around.

export type Dir = "in" | "out" | "inout" | "ref";

export interface Loc {
  file: string;
  line: number;
}

export interface Port {
  name: string;
  dir: Dir;
  type: string;
  /** total width in bits; null for types without a fixed dimension */
  width: number | null;
  unpacked_dims: number[] | null;
  elem_width: number | null;
  loc: Loc | null;
}

export interface IfacePort {
  name: string;
  interface: string;
  modport: string | null;
  loc: Loc | null;
}

export interface ModuleDef {
  ports: Port[];
  iface_ports: IfacePort[];
  loc: Loc | null;
}

export interface IfaceSignal {
  name: string;
  type: string;
  width: number | null;
  unpacked_dims: number[] | null;
  elem_width: number | null;
}

export interface IfaceDetail {
  signals: IfaceSignal[];
  modports: Record<string, Record<string, Dir>>;
}

export interface Instance {
  /** stable ID: the elaborated hierarchical path (demo_top.u_soc.g_ch[1].u_ch) */
  path: string;
  module: string;
  /** the effective parameter values, as text */
  params: Record<string, string>;
  loc: Loc | null;
  /** present only for interface instances */
  iface?: IfaceDetail;
}

export type Conn =
  | null
  | { kind: "net"; net: string }
  | { kind: "concat"; parts: Conn[] }
  | { kind: "select"; base: Conn; index: string | null; text: string | null }
  | { kind: "const"; value: string }
  | { kind: "iface"; ref: string }
  | { kind: "expr"; text: string | null };

export interface ViewPin {
  pin: string;
  conn: Conn;
}

export interface ViewNet {
  name: string;
  endpoints: string[];
  fanout: number;
  render: "wire" | "label";
}

export interface View {
  module: string;
  pins: ViewPin[];
  nets: ViewNet[];
}

export interface ProjectModel {
  schema_version: 1;
  tops: string[];
  modules: Record<string, ModuleDef>;
  instances: Instance[];
  views: Record<string, View>;
}

export const SCHEMA_VERSION = 1;

/**
 * Lightweight structural validation of the model received from the backend.
 *
 * Does not replace the JSON schema (validated in the backend's pytest tests);
 * here only the schema version is checked — the host rejects unknown
 * versions (docs/02) — along with the overall shape, so that integration errors
 * surface early and intelligibly, not as deep exceptions in the UI.
 */
export function validateModel(data: unknown): ProjectModel {
  if (typeof data !== "object" || data === null) {
    throw new Error("modelul nu este un obiect JSON");
  }
  const m = data as Record<string, unknown>;
  if (m.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `versiune de schema necunoscuta: ${String(m.schema_version)} ` +
        `(host-ul intelege ${SCHEMA_VERSION})`
    );
  }
  if (!Array.isArray(m.tops) || m.tops.length === 0) {
    throw new Error("modelul nu are `tops`");
  }
  if (typeof m.modules !== "object" || m.modules === null) {
    throw new Error("modelul nu are `modules`");
  }
  if (!Array.isArray(m.instances)) {
    throw new Error("modelul nu are `instances`");
  }
  if (typeof m.views !== "object" || m.views === null) {
    throw new Error("modelul nu are `views`");
  }
  for (const inst of m.instances as unknown[]) {
    const i = inst as Record<string, unknown>;
    if (typeof i.path !== "string" || typeof i.module !== "string") {
      throw new Error("instanta fara `path`/`module` in model");
    }
  }
  return data as ProjectModel;
}
