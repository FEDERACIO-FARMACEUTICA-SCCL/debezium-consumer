export interface SupplierDeletion {
  CodSupplier: string;
  DeletionDate?: string | null;
}

export interface SupplierContactDeletion {
  CodSupplier: string;
  NIF: string;
  DeletionDate?: string | null;
}

export interface BulkResult {
  operation: "sync" | "delete";
  target: "supplier" | "contact";
  totalCodsuppliers: number;
  totalItems: number;
  batches: number;
  successBatches: number;
  failedBatches: number;
  skipped: number;
  durationMs: number;
}
