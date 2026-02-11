import { BulkHandler, BulkSyncResult, BulkDeletionResult } from "../bulk-handler";
import { PayloadRegistry } from "../../payloads/payload-builder";
import { store } from "../../domain/store";
import { PayloadType, SupplierContact } from "../../types/payloads";
import { SkippedDetail, SupplierContactDeletion } from "../../types/deletions";

export class ContactBulkHandler implements BulkHandler {
  readonly type: PayloadType = "contact";

  constructor(private registry: PayloadRegistry) {}

  syncAll(codigos: string[]): BulkSyncResult {
    const builder = this.registry.get("contact");
    const items: SupplierContact[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const gproveed = store.getSingle("gproveed", codigo);
      if (!gproveed) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Incomplete data: missing gproveed" });
        continue;
      }
      const direcciones = store.getArray("cterdire", codigo);
      if (direcciones.length === 0) {
        skippedDetails.push({ CodSupplier: codigo, reason: "No addresses found (cterdire)" });
        continue;
      }
      const result = builder?.build(codigo) as SupplierContact[] | null;
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
    const items: SupplierContactDeletion[] = [];
    const skippedDetails: SkippedDetail[] = [];

    for (const codigo of codigos) {
      const ctercero = store.getSingle("ctercero", codigo);
      if (!ctercero) {
        skippedDetails.push({ CodSupplier: codigo, reason: "Not found in store (ctercero)" });
        continue;
      }
      const nif = ctercero["cif"];
      if (nif == null || String(nif).trim() === "") {
        skippedDetails.push({ CodSupplier: codigo, reason: "Missing NIF (cif)" });
        continue;
      }
      items.push({
        CodSupplier: codigo,
        NIF: String(nif).trim(),
        DeletionDate: now,
      });
    }

    return { items, skippedDetails };
  }
}
