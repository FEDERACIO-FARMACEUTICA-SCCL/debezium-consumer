export interface DebeziumSource {
  version: string;
  connector: string;
  name: string;
  ts_ms: number;
  snapshot: string | boolean;
  db: string;
  sequence: string | null;
  schema: string;
  table: string;
  change_lsn: string | null;
  commit_lsn: string | null;
}

export interface DebeziumEvent<T = Record<string, unknown>> {
  before: T | null;
  after: T | null;
  source: DebeziumSource;
  op: "c" | "u" | "d" | "r"; // create, update, delete, read (snapshot)
  ts_ms: number;
  transaction: {
    id: string;
    total_order: number;
    data_collection_order: number;
  } | null;
}

export type Operation = DebeziumEvent["op"];

export const OP_LABELS: Record<Operation, string> = {
  c: "INSERT",
  u: "UPDATE",
  d: "DELETE",
  r: "SNAPSHOT",
};
