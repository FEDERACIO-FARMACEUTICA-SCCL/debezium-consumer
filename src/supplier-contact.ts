import { getCtercero, getGproveed, getCterdire, StoreRecord } from "./store";

export interface SupplierContact {
  IdSupplier: string;
  Name: string;
  NIF: string;
  Adress: string;
  City: string;
  Country: string;
  Postal_Code: string;
  Phone: string;
  E_Mail: string;
  Status: "ACTIVO" | "BAJA";
}

export interface SupplierContactPayload {
  Suppliers_Contacts: SupplierContact[];
}

export function buildSupplierContactPayload(
  codigo: string
): SupplierContactPayload | null {
  const ctercero = getCtercero(codigo);
  const gproveed = getGproveed(codigo);
  const direcciones = getCterdire(codigo);

  if (!ctercero || !gproveed) {
    console.log(
      `[SupplierContact] Incomplete data for codigo=${codigo} (ctercero: ${!!ctercero}, gproveed: ${!!gproveed})`
    );
    return null;
  }

  if (direcciones.length === 0) {
    console.log(
      `[SupplierContact] No addresses found for codigo=${codigo}`
    );
    return null;
  }

  const name = trimStr(ctercero["nombre"]);
  const nif = trimStr(ctercero["cif"]);
  const status: "ACTIVO" | "BAJA" =
    gproveed["fecbaj"] == null ? "ACTIVO" : "BAJA";

  const contacts: SupplierContact[] = direcciones.map((dir) => ({
    IdSupplier: `${codigo}-FC-UUID`,
    Name: name,
    NIF: nif,
    Adress: trimStr(dir["direcc"]),
    City: trimStr(dir["poblac"]),
    Country: trimStr(dir["codnac"]),
    Postal_Code: trimStr(dir["codpos"]),
    Phone: trimStr(dir["telef1"]),
    E_Mail: trimStr(dir["email"]),
    Status: status,
  }));

  return { Suppliers_Contacts: contacts };
}

function trimStr(value: unknown): string {
  return String(value ?? "").trim();
}
