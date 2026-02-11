const ISO3_TO_ISO2: Record<string, string> = {
  AFG: "AF", ALB: "AL", DZA: "DZ", AND: "AD", AGO: "AO",
  ARG: "AR", ARM: "AM", AUS: "AU", AUT: "AT", AZE: "AZ",
  BEL: "BE", BGR: "BG", BIH: "BA", BRA: "BR", CAN: "CA",
  CHE: "CH", CHL: "CL", CHN: "CN", COL: "CO", CRI: "CR",
  CUB: "CU", CYP: "CY", CZE: "CZ", DEU: "DE", DNK: "DK",
  DOM: "DO", ECU: "EC", EGY: "EG", ESP: "ES", EST: "EE",
  FIN: "FI", FRA: "FR", GBR: "GB", GEO: "GE", GRC: "GR",
  GTM: "GT", HND: "HN", HRV: "HR", HUN: "HU", IND: "IN",
  IRL: "IE", ISL: "IS", ISR: "IL", ITA: "IT", JPN: "JP",
  KOR: "KR", LTU: "LT", LUX: "LU", LVA: "LV", MAR: "MA",
  MCO: "MC", MDA: "MD", MEX: "MX", MKD: "MK", MLT: "MT",
  MNE: "ME", NLD: "NL", NOR: "NO", NZL: "NZ", PAN: "PA",
  PER: "PE", PHL: "PH", POL: "PL", PRT: "PT", PRY: "PY",
  ROU: "RO", RUS: "RU", SAU: "SA", SRB: "RS", SVK: "SK",
  SVN: "SI", SWE: "SE", THA: "TH", TUN: "TN", TUR: "TR",
  UKR: "UA", URY: "UY", USA: "US", VEN: "VE", ZAF: "ZA",
};

export function toISO2(code: unknown): string | null {
  if (code == null) return null;
  const trimmed = String(code).trim().toUpperCase();
  if (!trimmed) return null;
  // Already ISO2
  if (trimmed.length === 2) return trimmed;
  // ISO3 → ISO2
  return ISO3_TO_ISO2[trimmed] ?? trimmed;
}
