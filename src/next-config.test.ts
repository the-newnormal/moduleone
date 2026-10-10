import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config", () => {
  // Server action arguments include names and the emails logins are given to; `next dev` would
  // print them with every call.
  it("keeps server action arguments out of the dev server's log", () => {
    expect(nextConfig.logging && nextConfig.logging.serverFunctions).toBe(false);
  });

  // The grader and the live coach build their prompts from rubrics/*.md; without this rule the
  // build would try to read them as JavaScript.
  it("imports the rubric files as plain text", () => {
    expect(nextConfig.turbopack?.rules?.["*.md"]).toEqual({ type: "text" });
  });
});
