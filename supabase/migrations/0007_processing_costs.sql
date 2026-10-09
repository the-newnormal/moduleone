-- 0007: what each check-in cost to process, so the monthly bill can be checked.
--
-- One row per paid API call that succeeded: a transcription (how many seconds of audio, by which
-- model) or a grading (tokens in and out, by which model). Rows hold numbers and model names only:
-- no transcript, no grade, no member. The admin page (/admin/costs) adds them up by month and
-- prices them from src/lib/costs, so a price change needs no migration.
--
-- Written only by the check-in's server code with the service role (src/lib/checkin/process.ts),
-- like every other check-in write. Read by holders of the admin grant; nobody else sees it.

create table processing_costs (
  id                  bigint generated always as identity primary key,
  -- Kept when a check-in goes, so past months still add up.
  checkin_id          uuid references checkins(id) on delete set null,
  step                text not null check (step in ('transcription', 'grading')),
  -- e.g. 'openai:gpt-4o-transcribe' or 'claude-haiku-5-5' (the model that actually answered).
  model               text not null check (length(model) between 1 and 200),
  -- Transcription: the recording's length as the recorder reported it (null if it didn't).
  audio_ms            int check (audio_ms is null or audio_ms between 0 and 3600000),
  -- Grading: the API's usage figures. Output includes thinking.
  input_tokens        int check (input_tokens is null or input_tokens >= 0),
  output_tokens       int check (output_tokens is null or output_tokens >= 0),
  cache_read_tokens   int check (cache_read_tokens is null or cache_read_tokens >= 0),
  cache_write_tokens  int check (cache_write_tokens is null or cache_write_tokens >= 0),
  created_at          timestamptz not null default now(),
  constraint processing_costs_step_fields check (
    case step
      when 'transcription' then input_tokens is null and output_tokens is null
                                and cache_read_tokens is null and cache_write_tokens is null
      else audio_ms is null and input_tokens is not null and output_tokens is not null
           and cache_read_tokens is not null and cache_write_tokens is not null
    end
  )
);
create index processing_costs_created_at on processing_costs (created_at);
create index processing_costs_checkin on processing_costs (checkin_id);
alter table processing_costs enable row level security;

-- Read-only through the API; the identity column means the server never picks ids.
grant select on table processing_costs to authenticated;
grant all on table processing_costs to service_role;

create policy processing_costs_select on processing_costs for select to authenticated
  using (app_has_grant('admin'));
