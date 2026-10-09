import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_ROLES,
  asRecord,
  CODE_RE,
  isAssignableRole,
  isDivisionType,
  isDomainType,
  isIndex,
  isParentId,
  isTeamKind,
  isUuid,
  parseCode,
  parseEmail,
  parseLeaderTitle,
  parseName,
  parseNote,
} from "./validate";

const UUID = "3f2b8c1e-9d4a-4e6f-8a1b-2c3d4e5f6a7b";

describe("asRecord", () => {
  it("reads an object as it is and anything else as {}", () => {
    const form = { name: "Atlas" };
    expect(asRecord(form)).toBe(form);
    for (const value of [null, undefined, "Atlas", 7, true]) expect(asRecord(value)).toEqual({});
  });
});

describe("isUuid", () => {
  it.each([UUID, UUID.toUpperCase(), "00000000-0000-0000-0000-000000000000"])("accepts %s", (v) => {
    expect(isUuid(v)).toBe(true);
  });

  it.each([
    "",
    "not-a-uuid",
    UUID.slice(1),
    `${UUID}0`,
    UUID.replaceAll("-", ""),
    `{${UUID}}`,
    ` ${UUID}`,
    `${UUID}\n`,
    "3f2b8c1e-9d4a-4e6f-8a1b-2c3d4e5f6a7g",
    "3f2b8c1e_9d4a_4e6f_8a1b_2c3d4e5f6a7b",
    null,
    undefined,
    42,
    { id: UUID },
    [UUID],
  ])("refuses %o", (v) => {
    expect(isUuid(v)).toBe(false);
  });
});

describe("isParentId", () => {
  it("accepts a uuid or null (the top level), nothing else", () => {
    expect(isParentId(UUID)).toBe(true);
    expect(isParentId(null)).toBe(true);
    expect(isParentId(undefined)).toBe(false);
    expect(isParentId("")).toBe(false);
    expect(isParentId("null")).toBe(false);
  });
});

describe("isIndex", () => {
  it.each([0, 1, 9999, 10000])("accepts %s", (v) => {
    expect(isIndex(v)).toBe(true);
  });

  it.each([-1, 10001, 1.5, -0.5, NaN, Infinity, -Infinity, "1", null, undefined, 2 ** 53])(
    "refuses %o",
    (v) => {
      expect(isIndex(v)).toBe(false);
    },
  );
});

describe("enums", () => {
  it("knows the kinds and types 0003 allows", () => {
    expect(["division", "domain", "team"].every(isTeamKind)).toBe(true);
    expect(["development", "ip", "lab"].every(isDomainType)).toBe(true);
    expect(["strategy", "support_development"].every(isDivisionType)).toBe(true);
    for (const bad of ["Division", "group", "", " team", null, undefined, 1]) {
      expect(isTeamKind(bad)).toBe(false);
    }
    expect(isDomainType("IP")).toBe(false);
    expect(isDomainType("strategy")).toBe(false);
    expect(isDivisionType("lab")).toBe(false);
    expect(isDivisionType("support and development")).toBe(false);
  });

  it("never lets an admin give the hq (Master Admin) role", () => {
    expect(ASSIGNABLE_ROLES).toEqual(["member", "leader"]);
    expect(isAssignableRole("member")).toBe(true);
    expect(isAssignableRole("leader")).toBe(true);
    for (const bad of ["hq", "HQ", "Master Admin", "admin", "Leader", "", null]) {
      expect(isAssignableRole(bad)).toBe(false);
    }
  });
});

describe("parseName", () => {
  it("trims", () => {
    expect(parseName("  Atlas  ")).toEqual({ ok: true, value: "Atlas" });
  });

  it("allows up to 120 characters, counted as Postgres does", () => {
    expect(parseName("a".repeat(120))).toEqual({ ok: true, value: "a".repeat(120) });
    expect(parseName("a".repeat(121)).ok).toBe(false);
    // 120 emoji are 240 UTF-16 units but 120 characters.
    expect(parseName("🌿".repeat(120)).ok).toBe(true);
    expect(parseName("🌿".repeat(121)).ok).toBe(false);
    expect(parseName(`  ${"a".repeat(120)}  `).ok).toBe(true);
  });

  it.each(["", "   ", "\n\t", null, undefined, 5, ["Atlas"]])("refuses an empty or missing name: %o", (v) => {
    expect(parseName(v)).toEqual({ ok: false, error: "Enter a name." });
  });

  it.each(["Line\nbreak", "Line\u2028separator", "Paragraph\u2029separator", "Tab\there", "Nul\u0000", "Zero​width", "Bidi‮override"])(
    "refuses control and hidden characters: %j",
    (v) => {
      expect(parseName(v).ok).toBe(false);
    },
  );

  it("keeps accents, apostrophes and other scripts", () => {
    for (const name of ["Zoë O'Brien", "林美", "Ng Wei-Ming", "Ārun"]) {
      expect(parseName(name)).toEqual({ ok: true, value: name });
    }
  });
});

describe("parseCode", () => {
  it.each([
    ["IP.X", "IP.X"],
    ["ip.x", "IP.X"],
    [" ip.1 ", "IP.1"],
    ["YD", "YD"],
    ["ABCDEFGH", "ABCDEFGH"],
    ["ABCDEFGH.12345678", "ABCDEFGH.12345678"],
    ["a1.b2", "A1.B2"],
  ])("accepts %j as %j", (input, code) => {
    expect(parseCode(input)).toEqual({ ok: true, value: code });
  });

  it.each(["", "   ", null, undefined])("treats %j as no code", (input) => {
    expect(parseCode(input)).toEqual({ ok: true, value: null });
  });

  it.each([
    "IP..1",
    "IP.123456789",
    "ABCDEFGHI",
    "A.B.C",
    ".X",
    "X.",
    "IP-1",
    "IP 1",
    "IP_1",
    "É",
    "１",
    "IP.\nX",
    "IP.​X",
  ])("refuses %j", (input) => {
    const result = parseCode(input);
    expect(result.ok).toBe(false);
  });

  it("refuses something that isn't text", () => {
    expect(parseCode(12).ok).toBe(false);
    expect(parseCode({}).ok).toBe(false);
  });

  it("matches 0003's teams_code_format", () => {
    expect(CODE_RE.source).toBe("^[A-Z0-9]{1,8}(\\.[A-Z0-9]{1,8})?$");
  });
});

describe("parseLeaderTitle", () => {
  it("trims, and treats empty as no title", () => {
    expect(parseLeaderTitle("  President ")).toEqual({ ok: true, value: "President" });
    for (const empty of ["", "   ", null, undefined]) {
      expect(parseLeaderTitle(empty)).toEqual({ ok: true, value: null });
    }
  });

  it("allows up to 60 characters on one line, like 0006's teams_leader_title_format", () => {
    expect(parseLeaderTitle("t".repeat(60)).ok).toBe(true);
    expect(parseLeaderTitle("t".repeat(61))).toEqual({ ok: false, error: "Titles can be at most 60 characters." });
    for (const broken of ["Vice\nPresident", "Vice\u2028President", "Vice\u2029President"]) {
      expect(parseLeaderTitle(broken)).toEqual({
        ok: false,
        error: "Titles can't contain line breaks or hidden characters.",
      });
    }
    expect(parseLeaderTitle(3)).toEqual({ ok: false, error: "Titles must be text." });
  });
});

describe("parseNote", () => {
  it("trims, and treats empty as no note", () => {
    expect(parseNote("  Future division. ")).toEqual({ ok: true, value: "Future division." });
    for (const empty of ["", "  \n ", null, undefined]) {
      expect(parseNote(empty)).toEqual({ ok: true, value: null });
    }
  });

  it("allows up to 500 characters, with line breaks and tabs", () => {
    expect(parseNote("a".repeat(500)).ok).toBe(true);
    expect(parseNote("a".repeat(501)).ok).toBe(false);
    expect(parseNote("one\ntwo\tthree")).toEqual({ ok: true, value: "one\ntwo\tthree" });
  });

  it("stores a browser's \\r\\n line breaks as \\n, so they count once", () => {
    const typed = Array.from({ length: 250 }, () => "a").join("\r\n"); // 499 characters as \n
    const result = parseNote(typed);
    expect(result).toEqual({ ok: true, value: Array.from({ length: 250 }, () => "a").join("\n") });
    expect(parseNote("a\rb")).toEqual({ ok: true, value: "a\nb" });
  });

  it.each(["Nul\u0000", "Bell\u0007", "Zero​width", "Bidi‮"])("refuses hidden characters: %j", (v) => {
    expect(parseNote(v).ok).toBe(false);
  });

  it("refuses something that isn't text", () => {
    expect(parseNote(5).ok).toBe(false);
  });
});

describe("parseEmail", () => {
  it("trims and lower-cases", () => {
    expect(parseEmail("  Mei.Wong@Example.COM ")).toEqual({ ok: true, value: "mei.wong@example.com" });
  });

  it("allows up to 254 characters", () => {
    const at254 = `${"a".repeat(64)}@${"b".repeat(185)}.com`;
    expect(at254).toHaveLength(254);
    expect(parseEmail(at254).ok).toBe(true);
    expect(parseEmail(`a${at254}`).ok).toBe(false);
  });

  it.each([
    "",
    "   ",
    "plainaddress",
    "@example.com",
    "name@",
    "name@example",
    "name@example.",
    "name@.example.com",
    "name@example..com",
    "two@@example.com",
    "a@b@example.com",
    "with space@example.com",
    "name@exa mple.com",
    "tab\t@example.com",
    "line\n@example.com",
    "nbsp x@example.com",
    "zero​width@example.com",
    "nul\u0000@example.com",
    null,
    undefined,
    42,
  ])("refuses %j", (v) => {
    expect(parseEmail(v).ok).toBe(false);
  });

  it("accepts ordinary addresses", () => {
    for (const email of ["hq@example.com", "a+tag@sub.example.sg", "o'neil@example.org"]) {
      expect(parseEmail(email)).toEqual({ ok: true, value: email });
    }
  });
});
