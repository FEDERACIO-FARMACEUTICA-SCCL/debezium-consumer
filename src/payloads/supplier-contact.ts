import { store, StoreRecord } from "../domain/store";
import { logger } from "../logger";
import {
  SupplierContact,
  SupplierContactPayload,
  PayloadType,
} from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";

export class SupplierContactBuilder
  implements PayloadBuilder<SupplierContactPayload>
{
  readonly type: PayloadType = "contact";

  build(codigo: string): SupplierContactPayload | null {
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

    const name = trimStr(ctercero["nombre"]);
    const nif = trimStr(ctercero["cif"]);
    const status: "ACTIVO" | "BAJA" =
      gproveed["fecbaj"] == null ? "ACTIVO" : "BAJA";

    const contacts: SupplierContact[] = direcciones.map(
      (dir: StoreRecord) => ({
        IdSupplier: `${codigo}-FC-UUID`,
        Name: name,
        NIF: nif,
        Address: trimStr(dir["direcc"]),
        City: trimStr(dir["poblac"]),
        Country: trimStr(dir["codnac"]),
        Postal_Code: trimStr(dir["codpos"]),
        Phone: trimStr(dir["telef1"]),
        E_Mail: trimStr(dir["email"]),
        Status: status,
      })
    );

    return { Suppliers_Contacts: contacts };
  }
}

function trimStr(value: unknown): string {
  return String(value ?? "").trim();
}
