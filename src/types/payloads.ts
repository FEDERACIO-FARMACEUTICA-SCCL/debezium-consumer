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

export interface Agreement {
  Agreement: string;
  ChargeApply: number;
  ChargeValue: number;
  CodAgreement: string;
  CodType: string;
  DateEnd: string | null;
  DateStart: string | null;
  DelayDays: number;
  IdAgreementType: number;
  CodAgreement_Parent: string | null;
  IdBasePriceType: string;
  IdClient: string;
  IdLiquidation_Type: number;
  CodSupplier: string;
  IdTransfer: number;
  LockEnd: string | null;
  LockStart: string | null;
  NetCharge: number;
  Observations: string | null;
  PrintedChar: string;
  Updatable: number;
  UpdateRates: number;
}

export type PayloadType = "supplier" | "contact" | "agreement";

export type AnyPayload = Supplier[] | SupplierContact[] | Agreement[];
