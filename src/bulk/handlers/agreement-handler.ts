import { BulkHandler, BulkSyncResult, BulkDeletionResult } from "../bulk-handler";
import { PayloadRegistry } from "../../payloads/payload-builder";
import { store } from "../../domain/store";
import { PayloadType, Agreement } from "../../types/payloads";
import { SkippedDetail, AgreementDeletion } from "../../types/deletions";

export class AgreementBulkHandler implements BulkHandler {
  readonly type: PayloadType = "agreement";

  constructor(private registry: PayloadRegistry) {}

  syncAll(codigos: string[]): BulkSyncResult {
    const builder = this.registry.get("agreement");
    const items: Agreement[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const records = store.getArray("gvenacuh", codigo);
      if (records.length === 0) {
        skippedDetails.push({ CodSupplier: codigo, reason: "No agreements found (gvenacuh)" });
        continue;
      }
      const result = builder?.build(codigo) as Agreement[] | null;
      if (result) {
        items.push(...result);
      } else {
        skippedDetails.push({ CodSupplier: codigo, reason: "Builder returned null" });
      }
    }

    return { items, skippedDetails };
  }

  deleteAll(codigos: string[]): BulkDeletionResult {
    const now = new Date().toISOString();
    const items: AgreementDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const records = store.getArray("gvenacuh", codigo);
      if (records.length === 0) {
        skippedDetails.push({ CodSupplier: codigo, reason: "No agreements found (gvenacuh)" });
        continue;
      }
      for (const rec of records) {
        const cabid = String(rec["cabid"] ?? "").trim();
        if (cabid) {
          items.push({ CodAgreement: cabid, DeletionDate: now });
        }
      }
    }

    return { items, skippedDetails };
  }
}
