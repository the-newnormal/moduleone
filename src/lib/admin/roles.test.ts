import { describe, expect, it } from "vitest";
import { isEditableMember, type Role, roleLabel } from "./roles";

describe("roleLabel", () => {
  it("names each role in words, and hq as Master Admin", () => {
    expect(roleLabel("member")).toBe("Member");
    expect(roleLabel("leader")).toBe("Leader");
    expect(roleLabel("hq")).toBe("Master Admin");
  });

  it("never shows a raw value it doesn't know", () => {
    expect(roleLabel("admin" as Role)).toBe("Unknown role");
  });
});

describe("isEditableMember", () => {
  const me = "a0000000-0000-4000-8000-000000000001";
  const other = "a0000000-0000-4000-8000-000000000002";

  it("hides edit controls on Master Admin rows and on the admin's own row", () => {
    expect(isEditableMember({ id: other, role: "member" }, me)).toBe(true);
    expect(isEditableMember({ id: other, role: "leader" }, me)).toBe(true);
    expect(isEditableMember({ id: other, role: "hq" }, me)).toBe(false);
    expect(isEditableMember({ id: me, role: "leader" }, me)).toBe(false);
  });
});
