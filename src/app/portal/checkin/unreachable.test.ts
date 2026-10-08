import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error";
import { describe, expect, it } from "vitest";
import { OFFLINE_MESSAGE, settled, UPDATED_MESSAGE } from "./unreachable";

describe("settled", () => {
  it("passes an action's own result through", async () => {
    const result = { status: "accepted" } as const;
    expect(await settled(async () => result)()).toBe(result);
  });

  it("turns a call that never reached the server into an error the form can show", async () => {
    const offline = settled(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(offline()).resolves.toEqual({ status: "error", code: "failed", message: OFFLINE_MESSAGE });
  });

  it("asks for a refresh when the app was redeployed since the page loaded", async () => {
    const stale = settled(async () => {
      throw new UnrecognizedActionError("Server Action \"abc\" was not found on the server.");
    });
    await expect(stale()).resolves.toEqual({ status: "error", code: "failed", message: UPDATED_MESSAGE });
  });
});
