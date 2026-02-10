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

export interface SupplierContact {
  IdSupplier: string;
  Name: string;
  NIF: string;
  Address: string;
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

export type PayloadType = "supplier" | "contact";

export type AnyPayload = SupplierPayload | SupplierContactPayload;
