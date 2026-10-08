import "server-only";
import type { Grade } from "./types";

export * from "./types";

/** Grade one check-in transcript against the rubric with Claude. */
export async function gradeCheckin(input: { transcript: string }): Promise<Grade> {
  void input;
  throw new Error("gradeCheckin() is not implemented yet");
}
