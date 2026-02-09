import { getCtercero, getGproveed } from "./store";

export interface Supplier {
  IdSupplier: string;
  CodSupplier: string;
  Supplier: string;
  NIF: string;
  StartDate: string | null;
  Status: "ACTIVO" | "BAJA";
}

export interface SupplierPayload {
  Suppliers: Supplier[];
}

export function buildSupplierPayload(
  codigo: string
): SupplierPayload | null {
  const ctercero = getCtercero(codigo);
  const gproveed = getGproveed(codigo);

  if (!ctercero || !gproveed) {
    console.log(
      `[Supplier] Incomplete data for codigo=${codigo} (ctercero: ${!!ctercero}, gproveed: ${!!gproveed})`
    );
    return null;
  }

  const supplier: Supplier = {
    IdSupplier: `${codigo}-FC-UUID`,
    CodSupplier: String(codigo),
    Supplier: String(ctercero["nombre"] ?? "").trim(),
    NIF: String(ctercero["cif"] ?? "").trim(),
    StartDate: formatDate(gproveed["fecalt"]),
    Status: gproveed["fecbaj"] == null ? "ACTIVO" : "BAJA",
  };

  return { Suppliers: [supplier] };
}

/**
 * Debezium sends DATE fields as days since epoch (1970-01-01).
 * E.g. 18578 = 2020-11-08
 */
function formatDate(value: unknown): string | null {
  if (value == null) return null;

  let d: Date;

  if (typeof value === "number") {
    // Debezium io.debezium.time.Date: days since epoch
    d = new Date(value * 86_400_000);
  } else {
    d = new Date(String(value));
  }

  if (isNaN(d.getTime())) return null;

  return d.toISOString().split("T")[0]; // YYYY-MM-DD
}
