-- Scheduled fee reminders (weekly or every N days); same shape as marks_runs
create table fees_runs (
  id          serial primary key,
  run_day     date not null,             -- local day the run belongs to
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  manual      boolean not null default false,
  campaign_id int references campaigns(id) on delete set null,
  summary     jsonb
);
create index on fees_runs(run_day desc);
