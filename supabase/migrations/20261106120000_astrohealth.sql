-- AstroHealth system of record. Only the server, using the secret key, may touch
-- these tables. The browser talks to the server, so that per-role medical redaction
-- can't be bypassed: RLS is on with no policies, and public roles have no grants.

create table public.kv (
  k text primary key,
  v jsonb not null
);

create table public.vitals (
  ts bigint not null,
  crew_id text not null,
  hr double precision,
  rr double precision,
  spo2 double precision,
  sys double precision,
  dia double precision,
  temp double precision,
  rmssd double precision,
  news integer,
  activity text,
  primary key (crew_id, ts)
);

create table public.env_readings (
  ts bigint primary key,
  co2 double precision,
  o2 double precision,
  pressure double precision,
  cabin_temp double precision,
  humidity double precision,
  radiation double precision
);

create table public.alerts (
  id text primary key,
  raised_at bigint not null,
  status text not null,
  severity integer not null,
  crew_id text,
  data jsonb not null
);
create index alerts_status_idx on public.alerts (status, raised_at);

create table public.records (
  id text primary key,
  kind text not null,
  crew_id text,
  ts bigint not null,
  data jsonb not null,
  vis_onboard boolean not null,
  vis_ground boolean not null
);
create index records_kind_idx on public.records (kind, crew_id, ts);

create table public.medications (
  id text primary key,
  data jsonb not null
);

create table public.bundles (
  id text primary key,
  created_at bigint not null,
  data jsonb not null
);

create table public.audit (
  seq bigint primary key,
  ts bigint not null,
  actor text not null,
  role text,
  action text not null,
  target text,
  detail text,
  prev_hash text not null,
  hash text not null
);

-- The audit log is append-only, even for the server's own key
create function public.audit_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'the audit log is append-only';
end;
$$;

create trigger audit_no_change before update or delete on public.audit
  for each row execute function public.audit_append_only();
create trigger audit_no_truncate before truncate on public.audit
  for each statement execute function public.audit_append_only();

do $$
declare
  t text;
begin
  foreach t in array array['kv', 'vitals', 'env_readings', 'alerts', 'records', 'medications', 'bundles', 'audit'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated, public', t);
    execute format('grant select, insert, update, delete on table public.%I to service_role', t);
  end loop;
end;
$$;

revoke all on function public.audit_append_only() from anon, authenticated, public;
