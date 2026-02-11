import { PayloadType } from "../types/payloads";
import { SkippedDetail } from "../types/deletions";

export interface BulkSyncResult {
  items: unknown[];
  skippedDetails: SkippedDetail[];
}

export interface BulkDeletionResult {
  items: unknown[];
  skippedDetails: SkippedDetail[];
}

export interface BulkHandler {
  readonly type: PayloadType;
  syncAll(codigos: string[]): BulkSyncResult;
  deleteAll(codigos: string[]): BulkDeletionResult;
}
