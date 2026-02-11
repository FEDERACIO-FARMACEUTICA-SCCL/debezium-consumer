import { store } from "../domain/store";
import { logger } from "../logger";
import { Supplier, PayloadType } from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";
import { trimOrNull, isActive, formatDate } from "./payload-utils";

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
