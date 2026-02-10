import { WATCHED_FIELDS } from "./table-registry";
import { DebeziumEvent, Operation } from "../types/debezium";

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface ChangeResult {
  table: string;
  op: Operation;
  changedFields: FieldChange[];
}

function normalize(val: unknown): unknown {
  if (typeof val === "string") return val.trim();
  return val;
}

export function detectChanges(event: DebeziumEvent): ChangeResult | null {
  const table = event.source.table.toLowerCase();
  const fields = WATCHED_FIELDS[table];

  if (!fields) return null;

  const changedFields: FieldChange[] = [];

  for (const field of fields) {
    const beforeVal = event.before?.[field] ?? null;
    const afterVal = event.after?.[field] ?? null;

    switch (event.op) {
      case "c":
      case "r":
        changedFields.push({ field, before: null, after: afterVal });
        break;
      case "u":
        if (normalize(beforeVal) !== normalize(afterVal)) {
          changedFields.push({ field, before: beforeVal, after: afterVal });
        }
        break;
      case "d":
        changedFields.push({ field, before: beforeVal, after: null });
        break;
    }
  }

  if (changedFields.length === 0) return null;

  return { table, op: event.op, changedFields };
}
