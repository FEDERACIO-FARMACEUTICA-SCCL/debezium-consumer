export interface Supplier {
  CodSupplier: string;
  Supplier: string;
  NIF: string | null;
  StartDate: string | null;
  Status: string | null;
}

export interface SupplierContact {
  CodSupplier: string;
  Name: string;
  NIF: string | null;
  Adress: string | null;
  City: string | null;
  Country: string | null;
  Postal_Code: string | null;
  Phone: string | null;
  E_Mail: string | null;
  Status: string | null;
}

export type PayloadType = "supplier" | "contact";

export type AnyPayload = Supplier[] | SupplierContact[];
