"use client";

import { ConfirmButton } from "@/components/admin/team/confirm-button";
import { deleteRecording, resetCheckin } from "./actions";

// A Master Admin's controls on a check-in (0007): delete its recording (once it's graded, as the
// grader needs it until then), or reset the whole check-in. The database refuses anyone else; the
// page only shows these to hq.
export function CheckinControls({
  checkinId,
  memberName,
  hasRecording,
  graded,
  currentWeek,
}: {
  checkinId: string;
  memberName: string;
  hasRecording: boolean;
  graded: boolean;
  currentWeek: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2 border-t pt-3">
      {hasRecording && graded && (
        <ConfirmButton
          label={<>Delete recording<span className="sr-only"> of {memberName}</span></>}
          title={`Delete ${memberName}'s recording?`}
          description="The recording is deleted for good. The transcript and scores stay."
          confirmLabel="Delete recording"
          destructive
          run={() => deleteRecording(checkinId)}
          context="deleteRecording"
        />
      )}
      <ConfirmButton
        label={<>Reset check-in<span className="sr-only"> of {memberName}</span></>}
        title={`Reset ${memberName}'s check-in?`}
        description={
          currentWeek
            ? "The check-in, its recording, transcript and scores are deleted for good. They can record and submit this week's check-in again."
            : "The check-in, its recording, transcript and scores are deleted for good. That week has closed, so it can't be recorded again."
        }
        confirmLabel="Reset check-in"
        destructive
        run={() => resetCheckin(checkinId)}
        context="resetCheckin"
      />
    </div>
  );
}
