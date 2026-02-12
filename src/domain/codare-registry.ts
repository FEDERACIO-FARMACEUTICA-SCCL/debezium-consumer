import { PayloadType } from "../types/payloads";

export const CODARE_REGISTRY: { codare: string; payloadTypes: PayloadType[] }[] = [
  { codare: "PRO", payloadTypes: ["supplier", "contact"] },
  // Future: { codare: "LAB", payloadTypes: ["supplier", "contact", "laboratory"] },
];

const CODARE_MAP = new Map<string, Set<PayloadType>>(
  CODARE_REGISTRY.map((r) => [r.codare, new Set(r.payloadTypes)])
);

export function getAllowedTypes(
  codare: string | null | undefined
): Set<PayloadType> {
  if (codare == null) return new Set();
  return CODARE_MAP.get(String(codare).trim()) ?? new Set();
}
