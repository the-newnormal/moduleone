import { describe, expect, it } from "vitest";
import { EMPTY_NODE_FORM, nodeToForm, parseNodeFields, typeOptions } from "./node-fields";

describe("parseNodeFields", () => {
  it("cleans a domain's fields into its columns", () => {
    expect(
      parseNodeFields("domain", { name: "  Atlas ", code: " at.x ", type: "development", note: " Old\r\nnote " }),
    ).toEqual({
      ok: true,
      value: { name: "Atlas", code: "AT.X", domain_type: "development", division_type: null, note: "Old\nnote" },
    });
  });

  it("puts a division's type in division_type", () => {
    expect(parseNodeFields("division", { name: "Gather", type: "strategy" })).toEqual({
      ok: true,
      value: { name: "Gather", code: null, domain_type: null, division_type: "strategy", note: null },
    });
  });

  it("reads empty code, type and note as none", () => {
    for (const kind of ["division", "domain", "team"] as const) {
      expect(parseNodeFields(kind, { ...EMPTY_NODE_FORM, name: "X" })).toEqual({
        ok: true,
        value: { name: "X", code: null, domain_type: null, division_type: null, note: null },
      });
    }
  });

  it.each([
    ["domain", "strategy", "Pick one of the domain types, or none."],
    ["division", "lab", "Pick one of the division types, or none."],
    ["team", "lab", "Teams don't have a type."],
    ["domain", 3, "Pick one of the domain types, or none."],
  ] as const)("refuses a %s with type %o", (kind, type, error) => {
    expect(parseNodeFields(kind, { name: "X", type })).toEqual({ ok: false, errors: { type: error }, error });
  });

  it("collects every field's problem and names the first", () => {
    const result = parseNodeFields("domain", { name: " ", code: "ip..1", type: "nope", note: "x".repeat(501) });
    expect(result).toEqual({
      ok: false,
      error: "Enter a name.",
      errors: {
        name: "Enter a name.",
        code: "Codes are 1–8 letters or digits, optionally a dot and 1–8 more, like IP.X or IP.1.",
        type: "Pick one of the domain types, or none.",
        note: "Notes can be at most 500 characters.",
      },
    });
  });

  it("refuses something that isn't a form", () => {
    expect(parseNodeFields("team", null)).toMatchObject({ ok: false, error: "Enter a name." });
    expect(parseNodeFields("team", "Atlas")).toMatchObject({ ok: false, error: "Enter a name." });
  });

  it("ignores fields it doesn't know", () => {
    expect(parseNodeFields("team", { name: "IP Lab 1", kind: "division", archived_at: "now", id: "x" })).toEqual({
      ok: true,
      value: { name: "IP Lab 1", code: null, domain_type: null, division_type: null, note: null },
    });
  });
});

describe("typeOptions", () => {
  it("lists each kind's types with their labels", () => {
    expect(typeOptions("domain")).toEqual([
      { value: "development", label: "Development domain" },
      { value: "ip", label: "IP" },
      { value: "lab", label: "Lab" },
    ]);
    expect(typeOptions("division")).toEqual([
      { value: "strategy", label: "Strategy division" },
      { value: "support_development", label: "Support and development division" },
    ]);
    expect(typeOptions("team")).toEqual([]);
  });
});

describe("nodeToForm", () => {
  it("turns a row into form text and back", () => {
    const row = {
      name: "IP Lab",
      code: "IP.X",
      kind: "domain" as const,
      domain_type: "lab" as const,
      division_type: null,
      note: null,
    };
    const form = nodeToForm(row);
    expect(form).toEqual({ name: "IP Lab", code: "IP.X", type: "lab", note: "" });
    expect(parseNodeFields("domain", form)).toEqual({
      ok: true,
      value: { name: "IP Lab", code: "IP.X", domain_type: "lab", division_type: null, note: null },
    });
  });

  it("uses the division type for a division and none for a team", () => {
    const base = { name: "X", code: null, note: "n", domain_type: null };
    expect(nodeToForm({ ...base, kind: "division", division_type: "strategy" }).type).toBe("strategy");
    expect(nodeToForm({ ...base, kind: "team", division_type: null }).type).toBe("");
  });
});
