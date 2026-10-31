-- Marks statements (Daily Marks Report + manual 1-Click marks)

-- Every Frappe Assessment Result that went out, so no result is ever sent twice
create table marks_sent (
  result_name text primary key,          -- Frappe Assessment Result name
  plan        text not null,             -- Frappe Assessment Plan (the test)
  student_id  int references students(id) on delete cascade,
  campaign_id int references campaigns(id) on delete set null,
  run_id      int,                       -- marks_runs.id when sent by the daily report
  created_at  timestamptz not null default now()
);
create index on marks_sent(plan);

-- Daily Marks Report runs
create table marks_runs (
  id          serial primary key,
  run_day     date not null,             -- local day the run belongs to
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  manual      boolean not null default false,
  watermark   text,                      -- newest Frappe "creation" seen; the next run reads from here (minus a day of overlap)
  campaign_id int references campaigns(id) on delete set null,
  summary     jsonb
);
create index on marks_runs(run_day desc);

-- Tests held back because their marks looked half-entered; sent anyway after 2 days
create table marks_held (
  plan          text primary key,
  first_seen_at timestamptz not null default now()
);
