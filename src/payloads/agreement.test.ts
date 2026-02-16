import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../domain/store", () => {
  const getSingle = vi.fn();
  const getArray = vi.fn();
  return {
    store: { getSingle, getArray, getAllCodigos: vi.fn() },
  };
});

import { AgreementBuilder } from "./agreement";
import { store } from "../domain/store";

const mockGetArray = vi.mocked(store.getArray);

const GVENACUH_RECORD = {
  tercer: "P001",
  coment: "Acuerdo comercial test",
  cabid: "AC001",
  tipdoc: "VEN",
  fecfin: 20454, // epoch days
  fecini: 19488, // epoch days
  clasif: "CL001",
  terenv: "P001",
  impres: "S",
  indmod: "M",
  frmpag: "30",
};

describe("AgreementBuilder", () => {
  let builder: AgreementBuilder;

  beforeEach(() => {
    vi.clearAllMocks();
    builder = new AgreementBuilder();
  });

  it("has type 'agreement'", () => {
    expect(builder.type).toBe("agreement");
  });

  it("builds successful agreement payload", () => {
    mockGetArray.mockReturnValue([GVENACUH_RECORD]);

    const result = builder.build("P001");

    expect(result).not.toBeNull();
    expect(result).toHaveLength(1);
    expect(result![0]).toEqual({
      Agreement: "Acuerdo comercial test",
      ChargeApply: 0,
      ChargeValue: 0,
      CodAgreement: "AC001",
      CodType: "VEN",
      DateEnd: "2026-01-01",
      DateStart: "2023-05-11",
      DelayDays: 30,
      IdAgreementType: 1,
      CodAgreement_Parent: "CL001",
      IdBasePriceType: "PVL",
      IdClient: "00000000-0000-0000-0000-000000000000",
      IdLiquidation_Type: 10,
      CodSupplier: "P001",
      IdTransfer: 0,
      LockEnd: "2026-01-01",
      LockStart: "2023-05-11",
      NetCharge: 0,
      Observations: "Acuerdo comercial test",
      PrintedChar: "S",
      Updatable: 1,
      UpdateRates: 0,
    });
  });

  it("returns null when no gvenacuh records exist", () => {
    mockGetArray.mockReturnValue([]);

    expect(builder.build("P001")).toBeNull();
  });

  it("builds multiple agreements for multiple records", () => {
    mockGetArray.mockReturnValue([
      GVENACUH_RECORD,
      { ...GVENACUH_RECORD, cabid: "AC002", coment: "Second agreement" },
    ]);

    const result = builder.build("P001");

    expect(result).toHaveLength(2);
    expect(result![0].CodAgreement).toBe("AC001");
    expect(result![1].CodAgreement).toBe("AC002");
  });

  it("returns DelayDays 0 when frmpag is not a number", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, frmpag: "abc" }]);

    const result = builder.build("P001");

    expect(result![0].DelayDays).toBe(0);
  });

  it("returns DelayDays 0 when frmpag is null", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, frmpag: null }]);

    const result = builder.build("P001");

    expect(result![0].DelayDays).toBe(0);
  });

  it("returns Updatable 1 when indmod is M", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, indmod: "M" }]);

    const result = builder.build("P001");

    expect(result![0].Updatable).toBe(1);
  });

  it("returns Updatable 0 when indmod is not M", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, indmod: "N" }]);

    const result = builder.build("P001");

    expect(result![0].Updatable).toBe(0);
  });

  it("returns Updatable 0 when indmod is null", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, indmod: null }]);

    const result = builder.build("P001");

    expect(result![0].Updatable).toBe(0);
  });

  it("handles null fields gracefully", () => {
    mockGetArray.mockReturnValue([{
      tercer: "P001",
      coment: null,
      cabid: null,
      tipdoc: null,
      fecfin: null,
      fecini: null,
      clasif: null,
      terenv: null,
      impres: null,
      indmod: null,
      frmpag: null,
    }]);

    const result = builder.build("P001");

    expect(result).not.toBeNull();
    expect(result![0].Agreement).toBe("");
    expect(result![0].CodAgreement).toBe("");
    expect(result![0].CodType).toBe("");
    expect(result![0].DateEnd).toBeNull();
    expect(result![0].DateStart).toBeNull();
    expect(result![0].DelayDays).toBe(0);
    expect(result![0].CodAgreement_Parent).toBeNull();
    expect(result![0].CodSupplier).toBe("P001");
    expect(result![0].Observations).toBeNull();
    expect(result![0].PrintedChar).toBe("");
    expect(result![0].Updatable).toBe(0);
  });

  it("formats dates from epoch days", () => {
    mockGetArray.mockReturnValue([{ ...GVENACUH_RECORD, fecini: 0, fecfin: 1 }]);

    const result = builder.build("P001");

    expect(result![0].DateStart).toBe("1970-01-01");
    expect(result![0].DateEnd).toBe("1970-01-02");
  });

  it("trims whitespace from string fields", () => {
    mockGetArray.mockReturnValue([{
      ...GVENACUH_RECORD,
      coment: "  trimmed  ",
      cabid: "  AC001  ",
      tipdoc: "  VEN  ",
    }]);

    const result = builder.build("P001");

    expect(result![0].Agreement).toBe("trimmed");
    expect(result![0].CodAgreement).toBe("AC001");
    expect(result![0].CodType).toBe("VEN");
  });
});
