import { store } from "../domain/store";
import { logger } from "../logger";
import {
  Supplier,
  SupplierPayload,
  PayloadType,
} from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";

export class SupplierBuilder implements PayloadBuilder<SupplierPayload> {
  readonly type: PayloadType = "supplier";

  build(codigo: string): SupplierPayload | null {
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
      IdSupplier: `${codigo}-FC-UUID`,
      CodSupplier: String(codigo),
      Supplier: String(ctercero["nombre"] ?? "").trim(),
      NIF: String(ctercero["cif"] ?? "").trim(),
      StartDate: formatDate(gproveed["fecalt"]),
      Status: gproveed["fecbaj"] == null ? "ACTIVO" : "BAJA",
    };

    return { Suppliers: [supplier] };
  }
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
