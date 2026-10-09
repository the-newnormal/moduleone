import { describe, expect, it } from "vitest";
import { baseMimeType, draftPath, extensionFor, isOwnAudioPath } from "./audio";

const MEMBER = "3e3b0000-0000-4000-8000-000000000003";
const OTHER = "3e3b0000-0000-4000-8000-000000000004";
const WEEK = "2026-10-05";

describe("extensionFor", () => {
  it("maps recorder MIME types, ignoring codecs and case", () => {
    expect(extensionFor("audio/webm;codecs=opus")).toBe("webm");
    expect(extensionFor("Audio/MP4")).toBe("m4a");
    expect(extensionFor("audio/ogg; codecs=opus")).toBe("ogg");
  });

  it("refuses anything else", () => {
    expect(extensionFor("")).toBeNull();
    expect(extensionFor("video/webm")).toBeNull();
    expect(extensionFor("application/octet-stream")).toBeNull();
    expect(extensionFor("audio/wav")).toBeNull();
  });

  it("drops parameters", () => {
    expect(baseMimeType(" audio/webm ;codecs=opus")).toBe("audio/webm");
  });
});

describe("draftPath", () => {
  it("builds a path in the member's own folder for the week", () => {
    const path = draftPath(MEMBER, WEEK, "webm");
    expect(path).toMatch(new RegExp(`^${MEMBER}/${WEEK}-[0-9a-f-]{36}\\.webm$`));
    expect(isOwnAudioPath(path, MEMBER, WEEK)).toBe(true);
  });

  it("is different every time", () => {
    expect(draftPath(MEMBER, WEEK, "webm")).not.toBe(draftPath(MEMBER, WEEK, "webm"));
  });
});

describe("isOwnAudioPath", () => {
  const good = `${MEMBER}/${WEEK}-0b0e7f4a-8c1d-4a8e-9c3f-0a1b2c3d4e5f.webm`;

  it("accepts the member's own file for the week", () => {
    expect(isOwnAudioPath(good, MEMBER, WEEK)).toBe(true);
    expect(isOwnAudioPath(good, MEMBER)).toBe(true);
  });

  it("rejects another member's folder", () => {
    expect(isOwnAudioPath(good, OTHER)).toBe(false);
  });

  it("rejects another week's file when a week is given", () => {
    expect(isOwnAudioPath(good, MEMBER, "2026-10-12")).toBe(false);
  });

  it.each([
    `${MEMBER}/../${OTHER}/x.webm`,
    `${MEMBER}/..`,
    `${MEMBER}/${WEEK}-a/b.webm`,
    `${MEMBER}/.hidden`,
    `${MEMBER}/%2e%2e`,
    `${MEMBER}/${WEEK}-a..webm`,
    `${MEMBER}/`,
    `/${MEMBER}/${WEEK}-a.webm`,
    `${MEMBER}x/${WEEK}-a.webm`,
    `${MEMBER}/${WEEK}-a b.webm`,
    `${MEMBER}/${WEEK}-a.webm\n`,
  ])("rejects %j", (path) => {
    expect(isOwnAudioPath(path, MEMBER)).toBe(false);
  });

  it("rejects an empty member id", () => {
    expect(isOwnAudioPath("/x.webm", "")).toBe(false);
  });
});
