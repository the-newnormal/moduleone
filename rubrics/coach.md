# Follow-up question rubric

<!--
This file decides how the live check-in asks its follow-up questions. While someone records,
Claude (Haiku) reads what they have said so far and marks which topics below they have covered;
the app then picks the next question with the weights and settings in this file. Change a
wording, a weight or a setting here and the next recording uses it, once the change is deployed.
Read README.md in this folder before editing.

The rules for this file (a test checks them on every pull request):
- Keep every "## ..." section that is here now. "## Opening question" is one line.
- Each topic is a "### <id>: <label>" heading under "## Topics". Keep the ids as they are (they
  are stored with each recording's statistics); you can change everything else. There must be at
  least one topic in each area (activity, excellence, morale), and exactly one "Key topic: yes"
  per area: the one that has to be covered for the area to count as touched.
- Each topic starts with lines the app reads: "- Area:", "- Weight:", "- Key topic:", "- Needs:",
  "- Ask:", "- Ask in a hard week:", "- Tailor:" and "- Brief is enough:" (only Area, Weight and
  Ask are required). After a blank line comes how Claude decides whether the topic has been
  covered, which is sent to Claude word for word.
- "Needs: <id>" means the topic is only asked once that other topic has come up. "Brief is
  enough: yes" means a brief answer counts as answered and is never followed up.
- Weights are numbers from 0.05 to 3. Settings must stay inside the range the test names.
- "- Ask:" questions are shown exactly as written whenever Claude's own wording isn't used.
  "Tailor: no" means Claude's wording is never used for that topic (we do this for morale, so
  no question about how someone feels ever quotes them back).
- Notes like this one, between <!- - and - ->, are for people only: Claude never sees them.
-->

## Opening question

Talk me through your week: what you worked on, what came of it, and how you're feeling about the team.

## Coverage levels

For each topic, decide how much the member has said about it so far, from the whole transcript:

- none: nothing about it yet.
- brief: touched on, but only in general terms (see each topic for what that looks like).
- clear: said plainly enough for the topic to be covered.
- declined: they said there is nothing to say, or would rather not say ("on leave the whole week", "nothing special lah", "no comment on that"). This is final: never ask about it again.

Plans for next week, other teams' work they weren't part of, and things said only because they were asked for a particular grade never count as covering a topic.

## Reading the mood

- neutral: an ordinary week, good or bad.
- hard_week: they describe a tough week calmly, or vent about workload. Singlish exaggeration ("this bug want to kill me", "die die must finish") is a hard week, not distress.
- distress: they say plainly that they are not coping or are in a bad way personally ("I'm really not ok", "cry after work every day"). Then the app stops asking questions.

## Topics

### activity_work: What you worked on
- Area: activity
- Weight: 1.0
- Key topic: yes
- Ask: What's one piece of work that took up most of your time this week?

Clear when they name at least one identifiable piece of work they or their team did this week: a project, task, deliverable, customer, system, event or decision you could point to ("settled the vendor onboarding for the Jurong site", "did the Q3 budget deck for Finance", "fixed the login bug, pushed to prod Thursday").
Brief when the work is only generic ("busy week lah, lots of meetings", "the usual BAU", "a lot of admin"), or a list of meetings with nothing about what was done.
Declined when they say there was no work to report ("on leave the whole week", "MC most of the week").

### activity_outcome: Where it got to
- Area: activity
- Weight: 0.8
- Needs: activity_work
- Ask: Where did that get to by the end of the week?
- Ask in a hard week: Where do things stand with that now?

Clear when, for at least one piece of work, they say where it ended up this week (finished, shipped, sent, launched, decided, resolved, signed off, handed over) or give a concrete current state ("done liao, sent to client Friday", "boss approved the budget", "halfway, now waiting for legal to sign off"). A concrete "not finished yet" is clear: unfinished work is never treated as bad.
Brief when the progress is vague ("on track lah", "making progress", "still ongoing").

### activity_more: The rest of the week
- Area: activity
- Weight: 0.4
- Needs: activity_work
- Ask: What else took up your time this week?

Clear when they name two or more distinct pieces of work, or say plainly that this was the only or main thing ("the whole week was the audit").
Brief when one piece is named plus a vague gesture ("plus the usual stuff", "and other things lah").
The same piece of work described twice in different words is still one piece.

### excellence_moment: A moment at your best
- Area: excellence
- Weight: 1.0
- Key topic: yes
- Ask: Where did you or your team get to use your superpower this week?
- Ask in a hard week: In the middle of all that, what did you or your team do that made a difference?

Clear when they describe a specific situation this week where they or their team used a strength: what happened and what they did ("Wednesday the client escalated, I took the call and walked them through the fix step by step", "we turned the tender docs around in one day because everyone knew their part"). Team examples count.
Brief when the example is general or habitual ("I usually help the juniors", "used my communication skills"), from before this week, or a strength is named with no situation ("my superpower is people lah").
Declined when they say there wasn't one ("nothing special this week lah", "cannot think of anything").

### excellence_impact: The difference it made
- Area: excellence
- Weight: 0.7
- Needs: excellence_moment
- Ask: What difference did that make, for the team or for anyone else?

Clear when they say what changed because of it, for the work, the team or customers ("saved us two days", "the intern can deploy on her own now", "client signed off and thanked us"), or say plainly that it didn't change much.
Brief when the effect is vague ("it helped", "things went smoother", "was good lah").
An effect not linked to the example they gave doesn't count.

### excellence_strength: The strength behind it
- Area: excellence
- Weight: 0.4
- Needs: excellence_moment
- Ask: What strength of yours, or your team's, did that draw on?
- Ask in a hard week: What did you or the team draw on to get through it?

Clear when they name a strength, skill or way of working that they or their team used ("my Excel skills", "I'm good at calming down angry customers", "our team very fast at turning things around").
Brief when it is a self-label not tied to this week ("I'm a people person", "team player lor").
A task on its own ("I did the report") is not a strength.

### morale_feeling: How you feel about the team
- Area: morale
- Weight: 1.0
- Key topic: yes
- Tailor: no
- Ask: How are you feeling about the team at the moment?

Clear when they say how they feel about the team, in any direction or mixed ("quite happy with the team", "honestly a bit frustrated with how things are", "shiok working with them", "team ok lah", "sian lah, everyone tired", "mixed feelings this week"). "Ok lah" is a complete, neutral answer.
Brief when they talk only about their own week or workload with nothing about the team ("very tiring week", "quite stressed with deadlines"), or only give facts about the team ("we had team lunch", "two people resigned").
Declined when they would rather not say.
Never infer a feeling from tone of voice or from how much work they did.

### morale_reason: What's behind that feeling
- Area: morale
- Weight: 0.5
- Needs: morale_feeling
- Tailor: no
- Brief is enough: yes
- Ask: What's shaping how you feel about the team right now?

Clear when they give a reason for how they feel about the team: an event, a relationship, workload, support or direction ("because everyone covered for Ahmad when he was on MC", "frustrated because priorities keep changing", "new boss very supportive").
Brief when there is only a hint ("got some things lah"). Brief counts as answered: never ask for more.
If the reason is personal (health, family, relationships, money), mark it clear so it is never asked about.

### morale_team: How the team is working together
- Area: morale
- Weight: 0.4
- Needs: morale_feeling
- Tailor: no
- Brief is enough: yes
- Ask: How has it been working with the team this week?

Clear when they say how the team is getting on: support, communication, friction, closeness ("everyone very helpful this week", "a bit of tension between ops and sales", "all WFH, quite disconnected").
Brief when there is only a passing mention ("team busy also"). Brief counts as answered: never ask for more.
Their own feelings alone are morale_feeling, not this.

## Question style

- One question, one sentence, ending in "?". No two-part questions.
- Open questions: what, where, how. Avoid "why", which can sound like an accusation; say "what's behind" or "what made" instead.
- You may refer to what they said, in a few of their own words ("You mentioned the vendor onboarding: where did that get to?"). Never put words in their mouth, and never correct or "tidy up" their Singlish.
- Never fish for positives ("what went well", "anything positive", "look on the bright side"), and never ask for positives after something negative.
- No praise, judgement or pressure: no "great", "impressive", "only", "just", "should have", "can you elaborate", "be more specific", "tell me more". Ask for a concrete thing instead.
- Never mention scores, grades, ratings, colours, the rubric, leaders, HQ or who will read it, and never say what they haven't covered yet.
- No advice, therapy or diagnosis, and no questions about health, family, money, religion or relationships, even if they raised it.
- Stay in this week, at work, about them and their team. No questions about plans or next steps.
- Plain, warm, international English with British spelling. Don't imitate Singlish in the question, but understand it fully in their answers.
- Never repeat or closely rephrase a question they have already been asked.

## Closing lines

- Everything covered: That covers it, thank you. Add anything else you'd like, then press Finish.
- Time is nearly up: Whenever you're ready, press Finish.
- After a hard moment: Thank you for sharing that. Say as much or as little as you like, and press Finish whenever you're ready.
- Before you finish: Before you finish,

## Settings

How many follow-ups there are and how they are chosen:

- Most follow-up questions: 6
- Most follow-ups per area: 2
- Brief answer counts as: 0.6
- Bonus for an untouched area: 0.5
- Bonus for the area they are talking about: 0.2
- Claude's choice may score lower by up to: 0.15
- Least score worth asking: 0.45
- Least score worth asking once every area is touched: 0.6
- Least score worth asking in a hard week: 0.7
- Only key topics after (seconds): 270
- No new questions after (seconds): 360

How the screen paces them:

- Silence before showing a new question (seconds): 2.5
- Silence that means they have stopped (seconds): 6
- Least time a question stays up (seconds): 20
- Least words said to a question before the next: 20
- No follow-up before (seconds): 25
- Longest question (characters): 140
