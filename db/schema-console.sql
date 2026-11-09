-- QA console schema.
--
-- The console is Eclypse's internal QA tool, a separate area from the
-- stand-in platform. Mirrors the in-memory store in lib/console/server/store.ts
-- one table per Map. Only objects prefixed console_ are created here. Nothing
-- in this file touches an eclypse_ table and no console table references one:
-- an employee is never a platform user.
--
-- Unlike db/schema.sql, nothing here is ever dropped or truncated. The
-- stand-in is wiped before every QA run so that runs are identical; the
-- console's employees, projects and job history are meant to stay. Every
-- statement is "if not exists", so running the file again is safe.
--
-- Same conventions as db/schema.sql: timestamps are epoch milliseconds stored
-- as bigint, matching Date.now() exactly, and row level security is enabled on
-- every table with no policies, so nothing but the server's secret key (which
-- bypasses RLS) can read or write these tables.

begin;

create table if not exists console_employees (
  id             text primary key,
  -- Stored lower case, so a lookup is an exact match and the unique
  -- constraint cannot be dodged with capital letters.
  email          text not null unique check (email = lower(email)),
  display_name   text not null,
  password_hash  text not null,
  totp_secret    text not null,
  -- False until the first sign-in proves the authenticator app works.
  totp_confirmed boolean not null default false,
  -- Last accepted TOTP time step. A code can only be used once.
  last_totp_step bigint not null default -1,
  created_at     bigint not null
);

create table if not exists console_challenges (
  id          text primary key,
  employee_id text not null references console_employees(id) on delete cascade,
  expires_at  bigint not null,
  attempts    integer not null default 0
);

create table if not exists console_sessions (
  id          text primary key,
  employee_id text not null references console_employees(id) on delete cascade,
  expires_at  bigint not null
);

create table if not exists console_projects (
  id                 text primary key,
  name               text not null,
  target_url         text not null,
  qa_email           text not null,
  -- The QA account's password and TOTP secret, AES-256-GCM encrypted by the
  -- server with CONSOLE_SECRET_KEY ("v1:iv:tag:ciphertext"). Never plain text.
  -- Null when not set. This is the demo version: production would keep the
  -- secrets in a secrets manager and store only a reference to them here.
  qa_password_enc    text,
  qa_totp_secret_enc text,
  created_at         bigint not null,
  -- Email of the employee who added the project.
  created_by         text not null
);

create table if not exists console_jobs (
  id                    text primary key,
  project_id            text not null references console_projects(id) on delete cascade,
  kind                  text not null check (kind in ('explore','qa')),
  status                text not null check (status in ('queued','running','passed','failed','error')),
  created_at            bigint not null,
  started_at            bigint,
  finished_at           bigint,
  created_by            text not null,
  -- Last lines of the child process output, secrets already redacted.
  log_tail              text not null default '',
  -- Explore jobs: the proposals, and the ids an employee approved.
  proposals             jsonb,
  approved_proposal_ids jsonb not null default '[]'::jsonb,
  -- QA jobs: verdict, counts and problems from the run's summary.json.
  result                jsonb,
  -- Human-readable reason when status is 'error'.
  error                 text,
  -- The console server process that runs the job. After a restart, a job
  -- whose process is gone is marked as an error instead of blocking the
  -- one-job-at-a-time rule for good.
  runner_host           text not null,
  runner_pid            integer not null
);

-- Where a job came from. Added after the table first shipped, so these are
-- "add column if not exists": existing rows get 'manual' and no commit.
-- commit_info is { sha, ref, runUrl } for runs started by GitHub Actions.
alter table console_jobs add column if not exists trigger_source text not null default 'manual'
  check (trigger_source in ('manual','github'));
alter table console_jobs add column if not exists commit_info jsonb;

-- Explore jobs: how the explorer ran ({ mode, model, steps, tokens, approxCostUsd }).
alter table console_jobs add column if not exists explorer jsonb;
-- The job's chat, oldest first. Answers to login and code questions are never
-- in here, only "Login provided" or "Code provided".
alter table console_jobs add column if not exists messages jsonb not null default '[]'::jsonb;
-- 'waiting': the run asked the employee for a login or a code and is paused.
-- The check is dropped and added again so this file stays safe to rerun.
alter table console_jobs drop constraint if exists console_jobs_status_check;
alter table console_jobs add constraint console_jobs_status_check
  check (status in ('queued','running','waiting','passed','failed','error'));

-- One GitHub connection per workspace: the employee's OAuth token, the repo
-- and branch the console polls, and how far it has got. The token is
-- AES-256-GCM encrypted by the server with CONSOLE_SECRET_KEY, like the QA
-- credentials in console_projects. Never plain text.
create table if not exists console_github_links (
  project_id        text primary key references console_projects(id) on delete cascade,
  token_enc         text,
  -- GitHub login of whoever connected.
  account           text,
  -- "owner/name".
  repo              text,
  branch            text,
  last_checked_at   bigint,
  -- The newest commit already handled. Only a commit after it starts a Probe.
  last_seen_sha     text,
  last_triggered_at bigint,
  -- GitHub's ETag for the branch head, so an unchanged branch costs no rate limit.
  etag              text,
  -- The GitHub-started job whose final commit status is not posted yet.
  pending_job_id    text
);

create index if not exists console_challenges_employee_idx on console_challenges (employee_id);
create index if not exists console_sessions_employee_idx   on console_sessions (employee_id);
create index if not exists console_jobs_project_idx        on console_jobs (project_id, created_at desc);
-- "Is anything running?" is asked before every job starts.
create index if not exists console_jobs_status_idx         on console_jobs (status);

alter table console_employees  enable row level security;
alter table console_challenges enable row level security;
alter table console_sessions   enable row level security;
alter table console_projects   enable row level security;
alter table console_jobs       enable row level security;
alter table console_github_links enable row level security;

commit;
