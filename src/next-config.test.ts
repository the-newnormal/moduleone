import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("next.config", () => {
  // Server action arguments include names and the emails logins are given to; `next dev` would
  // print them with every call.
  it("keeps server action arguments out of the dev server's log", () => {
    expect(nextConfig.logging && nextConfig.logging.serverFunctions).toBe(false);
  });
});
