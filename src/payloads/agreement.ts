import { store } from "../domain/store";
import { logger } from "../logger";
import { Agreement, PayloadType } from "../types/payloads";
import { PayloadBuilder } from "./payload-builder";
import { trimOrNull, formatDate } from "./payload-utils";

export class AgreementBuilder implements PayloadBuilder<Agreement[]> {
  readonly type: PayloadType = "agreement";

  build(codigo: string): Agreement[] | null {
    const records = store.getArray("gvenacuh", codigo);

    if (records.length === 0) {
      logger.info(
        { tag: "Agreement", codigo },
        "No agreements found for codigo"
      );
      return null;
    }

    const agreements: Agreement[] = records.map((rec) => ({
      Agreement: String(rec["coment"] ?? "").trim(),
      ChargeApply: 0,
      ChargeValue: 0,
      CodAgreement: String(rec["cabid"] ?? "").trim(),
      CodType: String(rec["tipdoc"] ?? "").trim(),
      DateEnd: formatDate(rec["fecfin"]),
      DateStart: formatDate(rec["fecini"]),
      DelayDays: parseInt(String(rec["frmpag"] ?? "0"), 10) || 0,
      IdAgreementType: 1,
      CodAgreement_Parent: trimOrNull(rec["clasif"]),
      IdBasePriceType: "PVL",
      // TODO: determinar el UUID real del cliente — la API requiere formato UUID
      IdClient: "00000000-0000-0000-0000-000000000000",
      IdLiquidation_Type: 10,
      CodSupplier: String(codigo).trim(),
      IdTransfer: 0,
      LockEnd: formatDate(rec["fecfin"]),
      LockStart: formatDate(rec["fecini"]),
      NetCharge: 0,
      Observations: trimOrNull(rec["coment"]),
      PrintedChar: String(rec["impres"] ?? "").trim(),
      Updatable: rec["indmod"] === "M" ? 1 : 0,
      UpdateRates: 0,
    }));

    return agreements;
  }
}
