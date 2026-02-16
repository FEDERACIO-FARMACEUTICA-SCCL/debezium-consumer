import { PayloadType } from "../types/payloads";

export const CODARE_REGISTRY: { codare: string; payloadTypes: PayloadType[] }[] = [
  { codare: "PRO", payloadTypes: ["supplier", "contact"] },
  // Future: { codare: "LAB", payloadTypes: ["supplier", "contact", "laboratory"] },
];

const CODARE_MAP = new Map<string, Set<PayloadType>>(
  CODARE_REGISTRY.map((r) => [r.codare, new Set(r.payloadTypes)])
);

/** Payload types exempt from codare filtering (dispatched for all terceros). */
export const CODARE_EXEMPT: Set<PayloadType> = new Set(["agreement"]);

export function isCodareExempt(type: PayloadType): boolean {
  return CODARE_EXEMPT.has(type);
}

export function getAllowedTypes(
  codare: string | null | undefined
): Set<PayloadType> {
  if (codare == null) return new Set();
  return CODARE_MAP.get(String(codare).trim()) ?? new Set();
}
