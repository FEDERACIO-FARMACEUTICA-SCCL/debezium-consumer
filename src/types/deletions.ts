export interface SupplierDeletion {
  CodSupplier: string;
  DeletionDate?: string | null;
}

export interface SupplierContactDeletion {
  CodSupplier: string;
  NIF: string;
  DeletionDate?: string | null;
}

export interface SkippedDetail {
  CodSupplier: string;
  reason: string;
}

export interface BulkResult {
  operation: "sync" | "delete";
  target: string;
  totalCodsuppliers: number;
  totalItems: number;
  batches: number;
  successBatches: number;
  failedBatches: number;
  skipped: number;
  skippedDetails: SkippedDetail[];
  durationMs: number;
}
