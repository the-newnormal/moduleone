import { checkinQuestion } from "@/lib/checkin/opening";
import { Tile } from "./tile";

// The week's question, to think about before pressing Start: the one open question from
// rubrics/coach.md; with the live check-in on, the follow-ups depend on what the member says.
export function QuestionsTile() {
  const { opening, live } = checkinQuestion();
  return (
    <Tile id="questions" title="This week's question">
      <p className="text-[15px] leading-[22px]">{opening}</p>
      <p className="text-[13px] leading-[18px] text-muted-foreground">
        {live && "As you talk, a follow-up question may appear when you pause. "}
        The topics are what you did, where you or your team were at your best, and how you feel about the team.
      </p>
    </Tile>
  );
}
