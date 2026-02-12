import { BulkHandler, BulkSyncResult, BulkDeletionResult } from "../bulk-handler";
import { PayloadRegistry } from "../../payloads/payload-builder";
import { store } from "../../domain/store";
import { getAllowedTypes } from "../../domain/codare-registry";
import { PayloadType, Supplier } from "../../types/payloads";
import { SkippedDetail, SupplierDeletion } from "../../types/deletions";

export class SupplierBulkHandler implements BulkHandler {
  readonly type: PayloadType = "supplier";

  constructor(private registry: PayloadRegistry) {}

  syncAll(codigos: string[]): BulkSyncResult {
    const builder = this.registry.get("supplier");
    const items: Supplier[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const allowed = getAllowedTypes(ctercero["codare"] as string);
      if (!allowed.has(this.type)) {
        skippedDetails.push({
          CodSupplier: codigo,
          reason: `codare '${String(ctercero["codare"] ?? "").trim()}' not applicable`,
        });
        continue;
      }
      const gproveed = store.getSingle("gproveed", codigo);
      if (!gproveed) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Incomplete data: missing gproveed" });
        continue;
      }
      const result = builder?.build(codigo) as Supplier[] | null;
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
    const items: SupplierDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const allowed = getAllowedTypes(ctercero["codare"] as string);
      if (!allowed.has(this.type)) {
        skippedDetails.push({
          CodSupplier: codigo,
          reason: `codare '${String(ctercero["codare"] ?? "").trim()}' not applicable`,
        });
        continue;
      }
      items.push({ CodSupplier: codigo, DeletionDate: now });
    }

    return { items, skippedDetails };
  }
}
