import { store, StoreRecord } from "../domain/store";
import { toISO2 } from "../domain/country-codes";
import { logger } from "../logger";
import { SupplierContact, PayloadType } from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";

export class SupplierContactBuilder
  implements PayloadBuilder<SupplierContact[]>
{
  readonly type: PayloadType = "contact";

  build(codigo: string): SupplierContact[] | null {
    const ctercero = store.getSingle("ctercero", codigo);
    const gproveed = store.getSingle("gproveed", codigo);
    const direcciones = store.getArray("cterdire", codigo);

    if (!ctercero || !gproveed) {
      logger.info(
        {
          tag: "SupplierContact",
          codigo,
          hasCtercero: !!ctercero,
          hasGproveed: !!gproveed,
        },
        "Incomplete data for contact payload"
      );
      return null;
    }

    if (direcciones.length === 0) {
      logger.info({ tag: "SupplierContact", codigo }, "No addresses found");
      return null;
    }

    const name = String(ctercero["nombre"] ?? "").trim();
    const nif = trimOrNull(ctercero["cif"]);
    const status = gproveed["fecbaj"] == null ? "ACTIVE" : "INACTIVE";

    const contacts: SupplierContact[] = direcciones.map(
      (dir: StoreRecord) => ({
        CodSupplier: String(codigo),
        Name: name,
        NIF: nif,
        Adress: trimOrNull(dir["direcc"]),
        City: trimOrNull(dir["poblac"]),
        Country: toISO2(dir["codnac"]),
        Postal_Code: trimOrNull(dir["codpos"]),
        Phone: trimOrNull(dir["telef1"]),
        E_Mail: trimOrNull(dir["email"]),
        Status: status,
      })
    );

    return contacts;
  }
}

function trimOrNull(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}
