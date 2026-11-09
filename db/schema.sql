-- Stand-in platform schema.
--
-- Mirrors lib/server/store.ts one table per Map. Only objects prefixed
-- eclypse_ are created, altered or dropped here.
--
-- Timestamps are epoch milliseconds stored as bigint, matching the app's
-- Date.now() values exactly. This is deliberate: it keeps the adapter a
-- straight field copy and removes a whole class of timezone bugs that would
-- otherwise show up as mysterious test failures.
--
-- Row level security is enabled on every table with no policies attached, so
-- nothing can read or write these tables except the server's secret key, which
-- bypasses RLS. A leaked publishable key therefore grants nothing.

begin;

drop table if exists eclypse_jobs cascade;
drop table if exists eclypse_documents cascade;
drop table if exists eclypse_challenges cascade;
drop table if exists eclypse_sessions cascade;
drop table if exists eclypse_invites cascade;
drop table if exists eclypse_memberships cascade;
drop table if exists eclypse_users cascade;
drop table if exists eclypse_tenants cascade;

create table eclypse_tenants (
  id    text primary key,
  slug  text not null unique,
  name  text not null
);

create table eclypse_users (
  id                 text primary key,
  email              text not null unique,
  password_hash      text not null,
  totp_secret        text not null,
  totp_confirmed     boolean not null default false,
  -- Last accepted TOTP time step. A code can only be used once.
  last_totp_step     bigint not null default -1,
  display_name       text not null,
  notification_email text not null default ''
);

create table eclypse_memberships (
  user_id   text not null references eclypse_users(id)   on delete cascade,
  tenant_id text not null references eclypse_tenants(id) on delete cascade,
  role      text not null check (role in ('admin','viewer')),
  primary key (user_id, tenant_id)
);

create table eclypse_invites (
  id         text primary key,
  tenant_id  text not null references eclypse_tenants(id) on delete cascade,
  email      text not null,
  role       text not null check (role in ('admin','viewer')),
  invited_at bigint not null,
  invited_by text not null
);

create table eclypse_sessions (
  id         text primary key,
  user_id    text not null references eclypse_users(id) on delete cascade,
  -- Null until the user picks an organization after sign-in.
  tenant_id  text references eclypse_tenants(id) on delete cascade,
  expires_at bigint not null
);

create table eclypse_challenges (
  id         text primary key,
  user_id    text not null references eclypse_users(id) on delete cascade,
  expires_at bigint not null,
  attempts   integer not null default 0
);

create table eclypse_documents (
  id          text primary key,
  tenant_id   text not null references eclypse_tenants(id) on delete cascade,
  name        text not null,
  size_bytes  bigint not null,
  -- CsvTable: { headers: string[], rows: string[][] }. "table" is reserved.
  table_json  jsonb not null,
  uploaded_at bigint not null,
  uploaded_by text not null
);

create table eclypse_jobs (
  id               text primary key,
  tenant_id        text not null references eclypse_tenants(id) on delete cascade,
  document_id      text not null,
  document_name    text not null,
  created_at       bigint not null,
  analysis_done_at bigint,
  report           jsonb,
  error            text
);

create index eclypse_memberships_tenant_idx on eclypse_memberships (tenant_id);
create index eclypse_sessions_user_idx       on eclypse_sessions (user_id);
create index eclypse_challenges_user_idx     on eclypse_challenges (user_id);
create index eclypse_invites_tenant_idx      on eclypse_invites (tenant_id);
create index eclypse_documents_tenant_idx    on eclypse_documents (tenant_id, uploaded_at desc);
create index eclypse_jobs_tenant_idx         on eclypse_jobs (tenant_id, created_at desc);

alter table eclypse_tenants     enable row level security;
alter table eclypse_users       enable row level security;
alter table eclypse_memberships enable row level security;
alter table eclypse_invites     enable row level security;
alter table eclypse_sessions    enable row level security;
alter table eclypse_challenges  enable row level security;
alter table eclypse_documents   enable row level security;
alter table eclypse_jobs        enable row level security;

-- Wipe every row, keeping the structure. The runner calls this before each run
-- so persistent state cannot carry between runs and break the
-- ten-identical-results proof. Restricted to the service role.
create or replace function eclypse_reset() returns void
language sql security definer as $$
  truncate eclypse_jobs, eclypse_documents, eclypse_challenges, eclypse_sessions,
           eclypse_invites, eclypse_memberships, eclypse_users, eclypse_tenants
  restart identity cascade;
$$;

revoke all on function eclypse_reset() from public, anon, authenticated;

commit;
