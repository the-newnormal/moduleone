import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The service-role client (./admin.ts) bypasses RLS, so only the team page's login actions (Give
// login, Resend invite, Change email, and Remove from Module One's login deletion), the check-in's
// server code (which writes for the member it takes from the session) and the Master Admin's
// delete and reset actions (which only remove the files the database handed back after checking
// the caller) may use it. This scans every source file under src/ and fails if anything else imports
// it, mocks it, or reads the service key itself. To use it somewhere new, that has to be a reviewed
// change to ALLOWED below.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TARGET = "src/lib/supabase/admin";

const ALLOWED = new Set([
  "src/lib/supabase/admin.ts",
  "src/lib/supabase/admin.test.ts",
  "src/lib/supabase/admin-imports.test.ts",
  "src/app/admin/teams/[id]/actions.ts", // giveLogin, resendInvite, changeEmail, removePerson
  "src/app/admin/teams/[id]/actions.test.ts",
  "src/app/portal/checkin/actions.ts", // recording, drafts and submitting a check-in
  "src/app/portal/checkin/actions.test.ts",
  "src/app/portal/checkin/housekeeping.ts", // tidying old drafts and files, the daily job
  "src/app/portal/checkin/housekeeping.test.ts",
  "src/lib/checkin/process.ts", // transcribing and grading a submitted check-in
  "src/lib/checkin/process.test.ts",
  "src/app/portal/dashboard/[teamId]/[week]/actions.ts", // removing files a Master Admin deleted (0007)
  "src/app/portal/dashboard/[teamId]/[week]/actions.test.ts",
]);

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return SOURCE.test(entry.name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

// Every module specifier in static and dynamic imports, re-exports, require() and vi.mock()-style
// calls.
const SPECIFIER =
  /(?:\bfrom|\bimport|\brequire|\.(?:mock|doMock|importActual|importMock))\s*\(?\s*(["'`])([^"'`]+)\1/g;

// Whether `source` (the file at repo-relative path `file`) refers to the service-role module.
function referencesServiceClient(file: string, source: string): boolean {
  for (const [, , spec] of source.matchAll(SPECIFIER)) {
    let path: string;
    if (spec.startsWith("@/")) path = `src/${spec.slice(2)}`;
    else if (spec.startsWith(".")) path = posix.normalize(posix.join(dirname(file), spec));
    else continue;
    path = path.replace(/\.(ts|tsx|js|mjs)$/, "").replace(/\/index$/, "");
    if (path === TARGET) return true;
  }
  return false;
}

// Reading the key (process.env.SUPABASE_SERVICE_ROLE_KEY, process.env["…"], { SUPABASE_SERVICE_ROLE_KEY } = process.env).
const READS_KEY = /\benv\b[\s\S]{0,40}SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY[\s\S]{0,40}=\s*process\.env/;

describe("the service-role client", () => {
  const files = sourceFiles(join(ROOT, "src"));

  it("finds the source files", () => {
    expect(files).toContain("src/lib/supabase/admin.ts");
    expect(files).toContain("src/lib/supabase/server.ts");
    expect(files.length).toBeGreaterThan(20);
  });

  it("is imported by nothing but the files allowed above", () => {
    const offenders = files.filter(
      (file) => !ALLOWED.has(file) && referencesServiceClient(file, readFileSync(join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("is the only code that reads the service key", () => {
    const readers = files.filter(
      (file) => !file.endsWith(".test.ts") && READS_KEY.test(readFileSync(join(ROOT, file), "utf8")),
    );
    expect(readers).toEqual(["src/lib/supabase/admin.ts"]);
  });

  it("is used only from server code: a server action file, or a module marked server-only", () => {
    for (const file of ALLOWED) {
      if (file.endsWith(".test.ts") || !files.includes(file)) continue;
      const source = readFileSync(join(ROOT, file), "utf8").trimStart();
      expect(source, file).toMatch(/^(["']use server["']|import ["']server-only["']);?/);
    }
  });

  it("never has a public (browser) variable for a secret", () => {
    for (const file of [...files, ".env.example"]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, file).not.toMatch(/NEXT_PUBLIC_\w*(SERVICE|SECRET)/);
    }
  });
});

describe("referencesServiceClient", () => {
  const from = "src/app/admin/structure/actions.ts";

  it.each([
    'import { createServiceRoleClient } from "@/lib/supabase/admin";',
    "import { createServiceRoleClient } from '@/lib/supabase/admin.ts';",
    'import * as admin from "../../../lib/supabase/admin";',
    'export { createServiceRoleClient } from "@/lib/supabase/admin";',
    'const { createServiceRoleClient } = await import("@/lib/supabase/admin");',
    'const admin = require("@/lib/supabase/admin");',
    'vi.mock("@/lib/supabase/admin", () => ({}));',
    'await vi.importActual("@/lib/supabase/admin");',
    "import {\n  createServiceRoleClient,\n} from\n  `@/lib/supabase/admin`;",
  ])("catches %j", (source) => {
    expect(referencesServiceClient(from, source)).toBe(true);
  });

  it.each([
    'import { createClient } from "@/lib/supabase/server";',
    'import { requireAdmin } from "@/lib/admin/session";',
    'import { thing } from "@/lib/supabase/admin-helpers";',
    'import { thing } from "./admin";', // src/app/admin/structure/admin, not the client
    "// the service-role client lives in src/lib/supabase/admin.ts",
  ])("ignores %j", (source) => {
    expect(referencesServiceClient(from, source)).toBe(false);
  });

  it("resolves relative paths from the importing file", () => {
    expect(referencesServiceClient("src/lib/supabase/other.ts", 'import x from "./admin";')).toBe(true);
    expect(referencesServiceClient("src/lib/other.ts", 'import x from "./supabase/admin";')).toBe(true);
  });
});
