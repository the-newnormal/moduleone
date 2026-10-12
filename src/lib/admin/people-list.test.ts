import { describe, expect, it } from "vitest";
import { TOO_MANY_PEOPLE } from "@/app/admin/teams/[id]/messages";
import { type ListedPerson, type ListEntry, MAX_PEOPLE, parsePeopleList } from "./people-list";

// The sentences a line can be refused with: the parser's own, and parseName's and parseEmail's
// (validate.ts), which it passes on as they are.
const ONE_EMAIL = "This line has more than one email address. Put each person on their own line.";
const ONE_ROLE = "Give one role per person.";
const ENTER_NAME = "Enter a name.";
const OWN_LINE =
  "This line has more than a name, an email and a role. Put the whole name in one column, and leave out any other columns.";
const OWNER_ONLY = "Only the project owner makes someone a Master Admin.";
const TOO_MANY = "A list can add at most 200 people. Add the rest in another list.";
const twice = (line: number) => `That email is on line ${line} too.`;
const EMAIL_LIKE = "Enter an email address like name@example.com.";
const EMAIL_SPACES = "Email addresses can't contain spaces.";
const EMAIL_TOO_LONG = "Email addresses can be at most 254 characters.";
const NAME_HIDDEN = "Names can't contain line breaks or hidden characters.";
const NAME_TOO_LONG = "Names can be at most 120 characters.";

const person = (
  name: string,
  email: string | null = null,
  role: ListedPerson["role"] = null,
): ListedPerson => ({ name, email, role });
const ok = (line: number, listed: ListedPerson): ListEntry => ({ line, ok: true, person: listed });
const bad = (line: number, text: string, error: string): ListEntry => ({ line, ok: false, text, error });

// The list's lines for people 1 to n, each with their own address.
const numbered = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `Person ${from + i}, person${from + i}@example.com`);

describe("MAX_PEOPLE", () => {
  it("is the 200 people admin_add_members (0014) adds at most", () => {
    expect(MAX_PEOPLE).toBe(200);
  });

  it("is refused with the same sentence in the dialog and in createMembers", () => {
    expect(TOO_MANY_PEOPLE).toBe(TOO_MANY);
  });
});

describe("parsePeopleList", () => {
  describe("blank input", () => {
    it.each(["", "   ", "\n", "\n\n\n", " \t \r\n  \r ", "\t\t\n\t"])(
      "lists nobody for an empty or blank list: %j",
      (text) => {
        expect(parsePeopleList(text)).toEqual([]);
      },
    );

    it("lists nobody for a list of column headings alone", () => {
      expect(parsePeopleList("Name, Email, Role\n\n")).toEqual([]);
    });
  });

  describe("one person per line", () => {
    it("reads a name on its own as a person with no email and the list's role", () => {
      expect(parsePeopleList("Mei Wong")).toEqual([ok(1, person("Mei Wong"))]);
    });

    it.each([
      "Mei Wong, mei@example.com",
      "Mei Wong; mei@example.com",
      "Mei Wong\tmei@example.com",
      "Mei Wong <mei@example.com>",
      "Mei Wong<mei@example.com>",
      "  Mei Wong ,   mei@example.com  ",
      "Mei Wong;mei@example.com",
    ])("reads a name and an email from %j", (text) => {
      expect(parsePeopleList(text)).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    });

    it("reads Name <email> with spaces inside the brackets, and beside a role", () => {
      expect(parsePeopleList("Mei Wong < mei@example.com >")).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
      expect(parsePeopleList("Mei Wong <mei@example.com>, Leader")).toEqual([
        ok(1, person("Mei Wong", "mei@example.com", "leader")),
      ]);
      expect(parsePeopleList("Mei Wong <mei@example.com>\tMember")).toEqual([
        ok(1, person("Mei Wong", "mei@example.com", "member")),
      ]);
    });

    it("splits a line with a tab only at its tabs, so a comma or semicolon can stay in a name", () => {
      expect(parsePeopleList("Wong, Mei\tmei@example.com")).toEqual([ok(1, person("Wong, Mei", "mei@example.com"))]);
      expect(parsePeopleList("Wong; Mei\tLeader")).toEqual([ok(1, person("Wong; Mei", null, "leader"))]);
      expect(parsePeopleList("Wong, Mei <mei@example.com>\tLeader")).toEqual([
        ok(1, person("Wong, Mei", "mei@example.com", "leader")),
      ]);
      // Without a tab, the same comma splits the name in two.
      expect(parsePeopleList("Wong, Mei, mei@example.com")).toEqual([
        bad(1, "Wong, Mei, mei@example.com", OWN_LINE),
      ]);
    });

    it("splits a spreadsheet row at its tabs even when its only tab is an empty column at the end", () => {
      expect(parsePeopleList("Wong, Mei\t")).toEqual([ok(1, person("Wong, Mei"))]);
      expect(parsePeopleList("Wong, Mei\t\tLeader\t")).toEqual([ok(1, person("Wong, Mei", null, "leader"))]);
    });

    it.each([
      "Mei Wong,,mei@example.com",
      "Mei Wong,mei@example.com,",
      ",Mei Wong, ,mei@example.com",
      "Mei Wong;;mei@example.com;",
      "Mei Wong\t\tmei@example.com",
      "\tMei Wong\t \tmei@example.com\t",
    ])("drops the empty parts an empty column leaves: %j", (text) => {
      expect(parsePeopleList(text)).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    });

    it("trims and lower-cases the email, as parseEmail stores it", () => {
      expect(parsePeopleList("Mei Wong,   MEI.Wong@Example.COM  ")).toEqual([
        ok(1, person("Mei Wong", "mei.wong@example.com")),
      ]);
      expect(parsePeopleList("Mei Wong <MEI@EXAMPLE.COM>")).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    });

    it("keeps the name as it was typed, trimmed, with its accents and its script", () => {
      expect(parsePeopleList("  Zoë O'Brien  , zoe@example.com\n林美\tlin@example.com\nNg Wei-Ming")).toEqual([
        ok(1, person("Zoë O'Brien", "zoe@example.com")),
        ok(2, person("林美", "lin@example.com")),
        ok(3, person("Ng Wei-Ming")),
      ]);
    });

    it("accepts a name of 120 characters, counted as Postgres counts them", () => {
      expect(parsePeopleList(`${"a".repeat(120)}, a@example.com`)).toEqual([
        ok(1, person("a".repeat(120), "a@example.com")),
      ]);
      // 120 emoji are 240 UTF-16 units but 120 characters.
      expect(parsePeopleList("🌿".repeat(120))).toEqual([ok(1, person("🌿".repeat(120)))]);
    });

    it("accepts an email of 254 characters", () => {
      const email = `${"a".repeat(242)}@example.com`;
      expect(email).toHaveLength(254);
      expect(parsePeopleList(`Mei Wong, ${email}`)).toEqual([ok(1, person("Mei Wong", email))]);
    });
  });

  describe("roles", () => {
    it.each([
      ["Member", "member"],
      ["member", "member"],
      ["MEMBER", "member"],
      ["mEmBeR", "member"],
      ["Leader", "leader"],
      ["leader", "leader"],
      ["LEADER", "leader"],
      [" lEaDeR ", "leader"],
    ] as const)("reads %j as the %s role", (cell, role) => {
      expect(parsePeopleList(`Mei Wong, mei@example.com,${cell}`)).toEqual([
        ok(1, person("Mei Wong", "mei@example.com", role)),
      ]);
    });

    it.each([
      "Mei Wong, mei@example.com, Leader",
      "Mei Wong, Leader, mei@example.com",
      "Leader, Mei Wong, mei@example.com",
      "Leader, mei@example.com, Mei Wong",
      "mei@example.com, Leader, Mei Wong",
      "mei@example.com; Mei Wong; Leader",
      "Leader\tmei@example.com\tMei Wong",
    ])("takes the name, email and role in any order: %j", (text) => {
      expect(parsePeopleList(text)).toEqual([ok(1, person("Mei Wong", "mei@example.com", "leader"))]);
    });

    it("leaves a line without a role to the role chosen for the whole list", () => {
      expect(parsePeopleList("Mei Wong, mei@example.com\nAda Lee, Member")).toEqual([
        ok(1, person("Mei Wong", "mei@example.com", null)),
        ok(2, person("Ada Lee", null, "member")),
      ]);
    });

    it.each([
      "Mei Wong, mei@example.com, Master Admin",
      "Mei Wong, MASTER ADMIN",
      "master admin; Mei Wong",
      "Mei Wong\tMaster admin",
    ])("refuses Master Admin, however it's written, with the owner-only sentence: %j", (text) => {
      expect(parsePeopleList(`  ${text}  `)).toEqual([bad(1, text, OWNER_ONLY)]);
    });

    // "HQ" is also a division's name, which a column of departments could hold: it isn't read as
    // the Master Admin role, so such a line has a column too many.
    it.each(["Mei Wong\thq", "HQ, Mei Wong, mei@example.com", "Mei Wong <mei@example.com>, Hq"])(
      "doesn't read HQ as a role: %j",
      (text) => {
        expect(parsePeopleList(text)).toEqual([bad(1, text, OWN_LINE)]);
      },
    );

    it.each([
      "Mei Wong, Member, Leader",
      "Mei Wong, Leader, leader",
      "Mei Wong, Leader, Master Admin",
      "Mei Wong\tMember\tmei@example.com\tLEADER",
    ])("refuses two roles on one line: %j", (text) => {
      expect(parsePeopleList(text)).toEqual([bad(1, text, ONE_ROLE)]);
    });
  });

  describe("column headings", () => {
    it.each([
      "Name, Email",
      "Name, Email, Role",
      "Name\tEmail\tRole",
      "NAME; E-MAIL; ROLE",
      "Full name, Email address",
      "Names, Emails",
      "Name <Email>",
      "Name\t\tEmail\t",
      "name",
      "Email",
    ])("skips %j on the first line", (headings) => {
      expect(parsePeopleList(`${headings}\nMei Wong, mei@example.com`)).toEqual([
        ok(2, person("Mei Wong", "mei@example.com")),
      ]);
    });

    it("skips headings on the first line that isn't blank, and counts the blank lines above them", () => {
      expect(parsePeopleList("\n   \nName, Email\nMei Wong, mei@example.com")).toEqual([
        ok(4, person("Mei Wong", "mei@example.com")),
      ]);
    });

    it("skips headings behind a byte-order mark, as a pasted file can start", () => {
      expect(parsePeopleList("﻿Name,Email\r\nMei Wong,mei@example.com")).toEqual([
        ok(2, person("Mei Wong", "mei@example.com")),
      ]);
    });

    it("reads headings on any later line as a person, so they're shown as a problem", () => {
      expect(parsePeopleList("Mei Wong, mei@example.com\nName, Email, Role\nName")).toEqual([
        ok(1, person("Mei Wong", "mei@example.com")),
        bad(2, "Name, Email, Role", OWN_LINE),
        ok(3, person("Name")),
      ]);
    });

    it("skips only one line of headings", () => {
      expect(parsePeopleList("Name, Email\nName, Email\nMei Wong")).toEqual([
        bad(2, "Name, Email", OWN_LINE),
        ok(3, person("Mei Wong")),
      ]);
    });

    it("reads a first line that is only partly headings as a person", () => {
      expect(parsePeopleList("Name, Email, Team\nMei Wong")).toEqual([
        bad(1, "Name, Email, Team", OWN_LINE),
        ok(2, person("Mei Wong")),
      ]);
    });

    it("still skips headings below a line of empty spreadsheet columns, which lists nobody", () => {
      // A CSV file's empty first row reads ",,": it lists nobody, like a blank line, so the headings
      // under it are still the list's first line.
      expect(parsePeopleList(",,\nName,Email,Role\nMei Wong,mei@example.com,Member")).toEqual([
        ok(3, person("Mei Wong", "mei@example.com", "member")),
      ]);
    });
  });

  describe("lines", () => {
    it("reads a block copied from a spreadsheet, with its headings, CRLF line ends and empty cells", () => {
      const pasted = [
        "Name\tEmail\tRole",
        "Mei Wong\tmei@example.com\tLeader",
        "Wong, Ada\t\tMember",
        "Sam Tan\tSAM@Example.com\t",
        "\t\t",
        "",
      ].join("\r\n");
      expect(parsePeopleList(pasted)).toEqual([
        ok(2, person("Mei Wong", "mei@example.com", "leader")),
        ok(3, person("Wong, Ada", null, "member")),
        ok(4, person("Sam Tan", "sam@example.com")),
      ]);
    });

    it("skips blank lines, but counts them in the line numbers the admin sees", () => {
      expect(parsePeopleList("\nMei Wong\n\n   \n\t\nAda Lee\n")).toEqual([
        ok(2, person("Mei Wong")),
        ok(6, person("Ada Lee")),
      ]);
    });

    it("skips a line that is only separators, without a problem", () => {
      expect(parsePeopleList("Mei Wong\n,,,\n ; ; \n<>\nAda Lee")).toEqual([
        ok(1, person("Mei Wong")),
        ok(5, person("Ada Lee")),
      ]);
    });

    it("splits at \\r\\n once, not twice", () => {
      expect(parsePeopleList("Mei Wong\r\nAda Lee\r\n\r\nSam Tan\r\n")).toEqual([
        ok(1, person("Mei Wong")),
        ok(2, person("Ada Lee")),
        ok(4, person("Sam Tan")),
      ]);
    });

    it("splits at a lone \\r, as old Mac files end their lines", () => {
      expect(parsePeopleList("Mei Wong\rAda Lee\r\rSam Tan")).toEqual([
        ok(1, person("Mei Wong")),
        ok(2, person("Ada Lee")),
        ok(4, person("Sam Tan")),
      ]);
    });

    it("splits a list with mixed line endings", () => {
      expect(parsePeopleList("Mei Wong\r\nAda Lee\nSam Tan\rJo Lim, jo@example.com")).toEqual([
        ok(1, person("Mei Wong")),
        ok(2, person("Ada Lee")),
        ok(3, person("Sam Tan")),
        ok(4, person("Jo Lim", "jo@example.com")),
      ]);
    });

    it("shows a refused line as the admin typed it, trimmed", () => {
      expect(parsePeopleList("   Mei Wong, mei@   \n\tAda Lee\tada@\t\r\n")).toEqual([
        bad(1, "Mei Wong, mei@", EMAIL_LIKE),
        bad(2, "Ada Lee\tada@", EMAIL_LIKE),
      ]);
    });

    it("gives a person's entry no text, and a refused line's entry no person", () => {
      const [good, refused] = parsePeopleList("Mei Wong\nAda Lee, ada@");
      expect(good).not.toHaveProperty("text");
      expect(good).not.toHaveProperty("error");
      expect(refused).not.toHaveProperty("person");
    });

    it("lists the people and the problems together, in line order", () => {
      expect(parsePeopleList("Mei Wong\nAda Lee, Sam Tan\nJo Lim, Leader\nmei@example.com")).toEqual([
        ok(1, person("Mei Wong")),
        bad(2, "Ada Lee, Sam Tan", OWN_LINE),
        ok(3, person("Jo Lim", null, "leader")),
        bad(4, "mei@example.com", ENTER_NAME),
      ]);
    });
  });

  describe("an email on two lines", () => {
    it("refuses the later line, naming the earlier one", () => {
      expect(
        parsePeopleList("Mei Wong, mei@example.com\nAda Lee, ada@example.com\nMei Tan, mei@example.com"),
      ).toEqual([
        ok(1, person("Mei Wong", "mei@example.com")),
        ok(2, person("Ada Lee", "ada@example.com")),
        bad(3, "Mei Tan, mei@example.com", twice(1)),
      ]);
    });

    it("finds the same address written in another case, with spaces or in another form", () => {
      expect(
        parsePeopleList("\nMei Wong <mei@example.com>\nMei Tan,   MEI@Example.COM  \nMei Lim\tMei@example.com"),
      ).toEqual([
        ok(2, person("Mei Wong", "mei@example.com")),
        bad(3, "Mei Tan,   MEI@Example.COM", twice(2)),
        bad(4, "Mei Lim\tMei@example.com", twice(2)),
      ]);
    });

    it("names the first line each time the address comes again", () => {
      expect(parsePeopleList("A One, x@example.com\nB Two, x@example.com\nC Three, x@example.com")).toEqual([
        ok(1, person("A One", "x@example.com")),
        bad(2, "B Two, x@example.com", twice(1)),
        bad(3, "C Three, x@example.com", twice(1)),
      ]);
    });

    it("leaves people with the same name alone (the dialog points those out)", () => {
      expect(parsePeopleList("Mei Wong\nMei Wong, mei@example.com\nMei Wong, wong@example.com")).toEqual([
        ok(1, person("Mei Wong")),
        ok(2, person("Mei Wong", "mei@example.com")),
        ok(3, person("Mei Wong", "wong@example.com")),
      ]);
    });
  });

  describe("at most MAX_PEOPLE people", () => {
    it("lists exactly MAX_PEOPLE people", () => {
      const entries = parsePeopleList(numbered(1, MAX_PEOPLE).join("\n"));
      expect(entries).toHaveLength(MAX_PEOPLE);
      expect(entries.every((entry) => entry.ok)).toBe(true);
      expect(entries[MAX_PEOPLE - 1]).toEqual(ok(MAX_PEOPLE, person("Person 200", "person200@example.com")));
    });

    it("keeps the first MAX_PEOPLE people and refuses each one after them", () => {
      const lines = ["Name, Email", ...numbered(1, MAX_PEOPLE), "", "Person 201, person201@example.com", "Person 202"];
      const entries = parsePeopleList(lines.join("\n"));
      expect(entries).toHaveLength(MAX_PEOPLE + 2);
      const kept = entries.slice(0, MAX_PEOPLE);
      expect(kept.every((entry) => entry.ok)).toBe(true);
      expect(kept[0]).toEqual(ok(2, person("Person 1", "person1@example.com")));
      expect(kept[MAX_PEOPLE - 1]).toEqual(ok(MAX_PEOPLE + 1, person("Person 200", "person200@example.com")));
      expect(entries.slice(MAX_PEOPLE)).toEqual([
        bad(MAX_PEOPLE + 3, "Person 201, person201@example.com", TOO_MANY),
        bad(MAX_PEOPLE + 4, "Person 202", TOO_MANY),
      ]);
    });

    it("counts only the people the list would add, not the lines it refuses", () => {
      const lines = [
        "Person​0, zero@example.com", // a hidden character
        ...numbered(1, 100),
        "Person 1 again, person1@example.com", // an address on line 2 too
        "Mei Wong, Master Admin",
        "Ada Lee, ada@",
        ...numbered(101, MAX_PEOPLE),
        "Person 201",
      ];
      const entries = parsePeopleList(lines.join("\n"));
      expect(entries.filter((entry) => entry.ok)).toHaveLength(MAX_PEOPLE);
      expect(entries.filter((entry) => !entry.ok)).toEqual([
        bad(1, "Person​0, zero@example.com", NAME_HIDDEN),
        bad(102, "Person 1 again, person1@example.com", twice(2)),
        bad(103, "Mei Wong, Master Admin", OWNER_ONLY),
        bad(104, "Ada Lee, ada@", EMAIL_LIKE),
        bad(lines.length, "Person 201", TOO_MANY),
      ]);
    });
  });

  describe("a bad email", () => {
    it.each([
      ["Mei Wong, mei@", EMAIL_LIKE],
      ["Mei Wong, @example.com", EMAIL_LIKE],
      ["Mei Wong, mei@example", EMAIL_LIKE],
      ["Mei Wong, mei@example.", EMAIL_LIKE],
      ["Mei Wong, mei@.example.com", EMAIL_LIKE],
      ["Mei Wong, mei@example..com", EMAIL_LIKE],
      ["Mei Wong, mei@@example.com", EMAIL_LIKE],
      ["Mei Wong <mei@>", EMAIL_LIKE],
      ["Mei Wong, mei wong@example.com", EMAIL_SPACES],
      ["Mei Wong\tmei wong@example.com", EMAIL_SPACES],
      ["Mei Wong, mei wong@example.com", EMAIL_SPACES],
      ["Mei Wong, mei​@example.com", EMAIL_SPACES],
      ["Mei Wong, mei @example.com", EMAIL_SPACES],
      [`Mei Wong, ${"a".repeat(243)}@example.com`, EMAIL_TOO_LONG],
    ])("refuses %j with parseEmail's sentence", (text, error) => {
      expect(parsePeopleList(text)).toEqual([bad(1, text, error)]);
    });

    it.each([
      "Mei Wong, mei@example.com, wong@example.com",
      "Mei Wong <mei@example.com>, wong@example.com",
      "Mei Wong <mei@example.com> <wong@example.com>",
      "mei@example.com\twong@example.com",
      "Mei @ Ops, mei@example.com",
    ])("refuses two emails on one line: %j", (text) => {
      expect(parsePeopleList(text)).toEqual([bad(1, text, ONE_EMAIL)]);
    });
  });

  describe("a bad name", () => {
    it.each([
      ["zero-width space", "Mei​Wong, mei@example.com"],
      ["direction override", "Mei‮Wong"],
      ["line separator, which doesn't start a new line", "Mei Wong, mei@example.com"],
      ["paragraph separator", "Mei Wong"],
      ["next line (U+0085)", "Mei\u0085Wong"],
      ["NUL", "Mei\u0000Wong"],
      ["bell", "Mei\u0007Wong"],
      ["form feed", "Mei\fWong"],
      ["vertical tab", "Mei\vWong"],
      ["soft hyphen", "Mei­Wong"],
    ])("refuses a %s in a name with parseName's sentence", (_, text) => {
      expect(parsePeopleList(text)).toEqual([bad(1, text, NAME_HIDDEN)]);
    });

    it("refuses a name over 120 characters with parseName's sentence", () => {
      const text = `${"a".repeat(121)}, a@example.com`;
      expect(parsePeopleList(text)).toEqual([bad(1, text, NAME_TOO_LONG)]);
      expect(parsePeopleList("🌿".repeat(121))).toEqual([bad(1, "🌿".repeat(121), NAME_TOO_LONG)]);
    });

    it.each([
      "Mei Wong, Ada Lee, mei@example.com",
      "Mei Wong; Ada Lee",
      "Mei Wong\tAda Lee",
      "Mei Wong, Ada Lee, Leader",
      "Mei <Ops>",
    ])("refuses two names on one line: %j", (text) => {
      expect(parsePeopleList(text)).toEqual([bad(1, text, OWN_LINE)]);
    });

    it.each(["mei@example.com", "<mei@example.com>", "Leader", "mei@example.com, Leader", "Master Admin"])(
      "refuses a line without a name: %j",
      (text) => {
        expect(parsePeopleList(text)).toEqual([bad(1, text, ENTER_NAME)]);
      },
    );
  });

  it("says one thing per line, in a fixed order: emails, then roles, then names", () => {
    expect(parsePeopleList("a@example.com, b@example.com, Member, Leader")).toEqual([
      bad(1, "a@example.com, b@example.com, Member, Leader", ONE_EMAIL),
    ]);
    expect(parsePeopleList("Member, Leader")).toEqual([bad(1, "Member, Leader", ONE_ROLE)]);
    expect(parsePeopleList("Mei​Wong, mei@")).toEqual([bad(1, "Mei​Wong, mei@", NAME_HIDDEN)]);
    expect(parsePeopleList("Mei Wong, mei@, Master Admin")).toEqual([
      bad(1, "Mei Wong, mei@, Master Admin", EMAIL_LIKE),
    ]);
  });

  it("keeps nothing from one list to the next", () => {
    expect(parsePeopleList("Mei Wong, mei@example.com")).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    // The same address again, in a new list, isn't a second use of it.
    expect(parsePeopleList("Mei Wong, mei@example.com")).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    // A new list's first line can still be its headings.
    expect(parsePeopleList("Name, Email\nAda Lee")).toEqual([ok(2, person("Ada Lee"))]);
    // And a new list counts its people from nought.
    expect(parsePeopleList(numbered(1, MAX_PEOPLE).join("\n")).every((entry) => entry.ok)).toBe(true);
    expect(parsePeopleList(numbered(1, MAX_PEOPLE).join("\n")).every((entry) => entry.ok)).toBe(true);
  });
});

describe("parsePeopleList: what mail programs, CSV files and documents copy", () => {
  it.each([
    ['"Mei Wong" <mei@example.com>', "Mei Wong"],
    ['“Mei Wong” <mei@example.com>', "Mei Wong"],
    ['"Wong, Mei" <mei@example.com>', "Wong, Mei"],
    ['"Wong; Mei" <mei@example.com>, Leader', "Wong; Mei"],
  ])("reads a quoted display name as the name: %j", (text, name) => {
    const role = text.endsWith("Leader") ? "leader" : null;
    expect(parsePeopleList(text)).toEqual([ok(1, person(name, "mei@example.com", role))]);
  });

  it("reads a CSV file's quoted fields, with commas inside them and doubled quotes", () => {
    const csv = ['"Name","Email","Role"', '"Wong, Mei","mei@example.com","Leader"', '"Leo ""LT"" Tan","leo@example.com",""'].join("\r\n");
    expect(parsePeopleList(csv)).toEqual([
      ok(2, person("Wong, Mei", "mei@example.com", "leader")),
      ok(3, person('Leo "LT" Tan', "leo@example.com")),
    ]);
  });

  it("never keeps quotes in a name or an address", () => {
    expect(parsePeopleList('"Mei Wong","mei@example.com"')).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
  });

  it("keeps a lone quote that isn't around the whole part (an unmatched one runs to the end of the line)", () => {
    expect(parsePeopleList('Mei "Wong, mei@example.com')).toEqual([
      bad(1, 'Mei "Wong, mei@example.com', ENTER_NAME),
    ]);
  });

  it("drops mailto: in front of an address, in any letter case", () => {
    expect(parsePeopleList("Mei Wong, mailto:mei@example.com\nLeo Tan <MAILTO:Leo@Example.com>")).toEqual([
      ok(1, person("Mei Wong", "mei@example.com")),
      ok(2, person("Leo Tan", "leo@example.com")),
    ]);
  });

  it.each(["• Mei Wong", "- Mei Wong", "* Mei Wong", "– Mei Wong", "1. Mei Wong", "12) Mei Wong", "· Mei Wong"])(
    "drops a bullet or a number in front of a name: %j",
    (text) => {
      expect(parsePeopleList(`${text}, mei@example.com`)).toEqual([ok(1, person("Mei Wong", "mei@example.com"))]);
    },
  );

  it("keeps a hyphen or a number that belongs to the name", () => {
    expect(parsePeopleList("Mei-Ling Wong\nAgent 47\n-Mei")).toEqual([
      ok(1, person("Mei-Ling Wong")),
      ok(2, person("Agent 47")),
      ok(3, person("-Mei")),
    ]);
  });

  it("says a line has two addresses when a mail program's recipients are pasted onto one line", () => {
    const text = "Mei Wong <mei@example.com>; Leo Tan <leo@example.com>";
    expect(parsePeopleList(text)).toEqual([bad(1, text, ONE_EMAIL)]);
  });

  it("says a line has a column too many for a spreadsheet with first and last names apart", () => {
    const text = "Mei\tWong\tmei@example.com";
    expect(parsePeopleList(text)).toEqual([bad(1, text, OWN_LINE)]);
  });

  it("skips headings under a line of empty columns a CSV file starts with", () => {
    expect(parsePeopleList(',,\r\nName,Email,Role\r\nMei Wong,mei@example.com,Member')).toEqual([
      ok(3, person("Mei Wong", "mei@example.com", "member")),
    ]);
  });
});
