import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./format";

// ICU may put a narrow no-break space before "am"/"pm"; compare with plain spaces.
const plain = (s: string | null) => s?.replace(/\s/g, " ") ?? null;

describe("formatDate / formatDateTime", () => {
  it("shows Singapore time, whatever the server's zone", () => {
    // 16:30 UTC on 8 Oct is 00:30 on 9 Oct in Singapore.
    expect(formatDate("2026-10-08T16:30:00Z")).toBe("9 Oct 2026");
    expect(plain(formatDateTime("2026-10-08T16:30:00Z"))).toBe("9 Oct 2026, 12:30 am");
    expect(plain(formatDateTime("2026-10-08T04:05:00.123456+00:00"))).toBe("8 Oct 2026, 12:05 pm");
  });

  it.each([null, undefined, "", "not a date"])("is null for %j", (value) => {
    expect(formatDate(value)).toBeNull();
    expect(formatDateTime(value)).toBeNull();
  });
});
