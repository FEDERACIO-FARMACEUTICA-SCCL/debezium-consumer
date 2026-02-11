import { store } from "../domain/store";
import { logger } from "../logger";
import { Supplier, PayloadType } from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";

export class SupplierBuilder implements PayloadBuilder<Supplier[]> {
  readonly type: PayloadType = "supplier";

  build(codigo: string): Supplier[] | null {
    const ctercero = store.getSingle("ctercero", codigo);
    const gproveed = store.getSingle("gproveed", codigo);

    if (!ctercero || !gproveed) {
      logger.info(
        {
          tag: "Supplier",
          codigo,
          hasCtercero: !!ctercero,
          hasGproveed: !!gproveed,
        },
        "Incomplete data for supplier payload"
      );
      return null;
    }

    const supplier: Supplier = {
      CodSupplier: String(codigo),
      Supplier: String(ctercero["nombre"] ?? "").trim(),
      NIF: trimOrNull(ctercero["cif"]),
      StartDate: formatDate(gproveed["fecalt"]),
      Status: isActive(gproveed["fecbaj"]) ? "ACTIVE" : "INACTIVE",
    };

    return [supplier];
  }
}

function trimOrNull(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function isActive(fecbaj: unknown): boolean {
  return fecbaj == null || String(fecbaj).trim() === "";
}

function formatDate(value: unknown): string | null {
  if (value == null) return null;

  let d: Date;

  if (typeof value === "number") {
    d = new Date(value * 86_400_000);
  } else {
    d = new Date(String(value));
  }

  if (isNaN(d.getTime())) return null;

  return d.toISOString().split("T")[0];
}
