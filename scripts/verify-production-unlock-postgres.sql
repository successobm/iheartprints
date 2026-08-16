-- Sprint A5.1 — REAL POSTGRESQL PROOF for `public.production_unlocks`.
--
-- Run against a throwaway database with the complete migration history
-- applied. Every check below is a claim about what the DATABASE refuses, not
-- about what application code remembers to check — which is the entire point
-- of putting the commercial authority in a constraint. Each assertion raises
-- an exception if the invariant does not hold, so a passing run means every
-- one actually executed.
--
-- Nothing here touches production. No customer data is read.
--
--   docker run -d --name ihp-a5-proof -e POSTGRES_PASSWORD=proof postgres:16
--   docker exec ihp-a5-proof psql -U postgres -c \
--     "create role anon nologin; create role authenticated nologin; \
--      create role service_role nologin bypassrls;"
--   docker exec ihp-a5-proof createdb -U postgres ihp_proof
--   docker exec ihp-a5-proof psql -U postgres -d ihp_proof -c "
--     -- Supabase provides `storage.buckets`; stub it for a bare image.
--     create schema storage;
--     create table storage.buckets (id text primary key, name text, public boolean);
--     -- Supabase's platform setup grants service_role table privileges on
--     -- everything in `public` BEFORE any project migration runs. A bare
--     -- Postgres image does not, and without modelling it PROOF 3b below
--     -- cannot distinguish 'the migration revoked from service_role' (a real
--     -- regression) from 'this fixture never granted anything' (a fixture
--     -- gap). Default privileges reproduce it for every table a later
--     -- migration creates.
--     grant usage on schema public to anon, authenticated, service_role;
--     alter default privileges in schema public
--       grant all on tables to service_role;"
--   -- apply supabase/migrations/*.sql in filename order, then this file.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

create temporary table t_ids (k text primary key, v uuid);

with s as (
  insert into public.acquisition_sessions (session_token)
  values ('a5-proof-session-a') returning id
)
insert into t_ids select 'session_a', id from s;

with s as (
  insert into public.acquisition_sessions (session_token)
  values ('a5-proof-session-b') returning id
)
insert into t_ids select 'session_b', id from s;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5 proof project 1', 'intake', (select v from t_ids where k = 'session_a'))
  returning id
)
insert into t_ids select 'project_1', id from p;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5 proof project 2', 'intake', (select v from t_ids where k = 'session_a'))
  returning id
)
insert into t_ids select 'project_2', id from p;

-- ---------------------------------------------------------------------------
-- 1. The table exists, with the expected authority-bearing shape.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.production_unlocks') is null then
    raise exception 'PROOF 1 FAILED: public.production_unlocks does not exist';
  end if;
end $$;

do $$
declare
  missing text;
begin
  select string_agg(expected, ', ')
    into missing
  from unnest(array[
    'id', 'project_id', 'acquisition_session_id', 'production_profile',
    'status', 'granted_at', 'revoked_at', 'revoked_reason',
    'created_at', 'updated_at'
  ]) as expected
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'production_unlocks'
      and column_name = expected
  );

  if missing is not null then
    raise exception 'PROOF 1b FAILED: production_unlocks is missing column(s): %', missing;
  end if;
end $$;

-- `acquisition_session_id` must be NOT NULL: a legacy project needs no
-- unlock at all, so there is no legitimate way to grant one without a
-- session, and a nullable column would let an unattributed grant exist.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'production_unlocks'
      and column_name in ('project_id', 'acquisition_session_id',
                          'production_profile', 'status')
      and is_nullable = 'YES'
  ) then
    raise exception 'PROOF 1c FAILED: an authority-bearing column is nullable';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS is enabled and NO policy exists.
-- ---------------------------------------------------------------------------
--
-- Zero policies plus RLS enabled denies every row to every non-bypassing
-- role. A policy appearing here later would be the exact regression the
-- server-only lockdown exists to prevent.

do $$
declare
  rls_on boolean;
  policy_count int;
begin
  select c.relrowsecurity into rls_on
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'production_unlocks';

  if not coalesce(rls_on, false) then
    raise exception 'PROOF 2 FAILED: row level security is not enabled on production_unlocks';
  end if;

  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'production_unlocks';

  if policy_count <> 0 then
    raise exception 'PROOF 2b FAILED: production_unlocks has % policy/policies; it must have zero', policy_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. anon / authenticated hold NO privileges; service_role is untouched.
-- ---------------------------------------------------------------------------

do $$
declare
  leaked text;
begin
  select string_agg(distinct grantee || ':' || privilege_type, ', ')
    into leaked
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name = 'production_unlocks'
    and grantee in ('anon', 'authenticated');

  if leaked is not null then
    raise exception 'PROOF 3 FAILED: production_unlocks grants to browser roles: %', leaked;
  end if;
end $$;

-- The second, independent control must not have taken the first one with it:
-- the server runs as service_role and depends on it.
do $$
begin
  if not has_table_privilege('service_role', 'public.production_unlocks', 'INSERT') then
    raise exception 'PROOF 3b FAILED: service_role cannot write production_unlocks';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. THE AUTHORITY INVARIANT — one ACTIVE unlock per (project, profile).
-- ---------------------------------------------------------------------------

insert into public.production_unlocks
  (project_id, acquisition_session_id, production_profile, status)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'session_a'),
   'apparel_raster', 'active');

do $$
begin
  begin
    insert into public.production_unlocks
      (project_id, acquisition_session_id, production_profile, status)
    values
      ((select v from t_ids where k = 'project_1'),
       (select v from t_ids where k = 'session_a'),
       'apparel_raster', 'active');
    raise exception 'PROOF 4 FAILED: a SECOND active unlock was accepted for the same project and profile';
  exception
    when unique_violation then
      null;  -- The refusal IS the guarantee.
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A revoked row frees the slot — a re-grant is a NEW row, not a revival.
-- ---------------------------------------------------------------------------
--
-- This is the intended policy: revocation is not deletion, the withdrawn row
-- stays as the audit trail a refund depends on, and a customer who buys again
-- gets an honest new `granted_at` rather than a resurrected old one.

update public.production_unlocks
set status = 'revoked', revoked_at = now(), revoked_reason = 'proof refund'
where project_id = (select v from t_ids where k = 'project_1');

insert into public.production_unlocks
  (project_id, acquisition_session_id, production_profile, status)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'session_a'),
   'apparel_raster', 'active');

do $$
declare
  total int;
  active int;
begin
  select count(*), count(*) filter (where status = 'active')
    into total, active
  from public.production_unlocks
  where project_id = (select v from t_ids where k = 'project_1');

  if total <> 2 then
    raise exception 'PROOF 5 FAILED: expected the revoked row to survive alongside the new grant (found % rows)', total;
  end if;
  if active <> 1 then
    raise exception 'PROOF 5b FAILED: expected exactly one active unlock, found %', active;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Project A's unlock does not imply Project B.
-- ---------------------------------------------------------------------------
--
-- The whole reason the key is the project rather than the session: both
-- projects below belong to the SAME acquisition session, and only one of them
-- is unlocked.

do $$
declare
  b_active int;
begin
  select count(*) into b_active
  from public.production_unlocks
  where project_id = (select v from t_ids where k = 'project_2')
    and status = 'active';

  if b_active <> 0 then
    raise exception 'PROOF 6 FAILED: project 2 has % active unlock(s) it was never granted', b_active;
  end if;
end $$;

-- And an unlock on project 2 is accepted independently — the constraint is
-- per (project, profile), not per session.
insert into public.production_unlocks
  (project_id, acquisition_session_id, production_profile, status)
values
  ((select v from t_ids where k = 'project_2'),
   (select v from t_ids where k = 'session_a'),
   'apparel_raster', 'active');

-- ---------------------------------------------------------------------------
-- 7. The profile CHECK refuses every non-grantable production category.
-- ---------------------------------------------------------------------------
--
-- The database must not authorize a future production path merely because a
-- string reached the column. Each of these is a real `ProductionCategory`
-- value that describes a refusal or a dormant role — none is a thing anyone
-- can be sold.

do $$
declare
  bad text;
begin
  foreach bad in array array[
    'apparel_vector', 'out_of_scope_product', 'signage',
    'logo_vector', 'unknown', 'embroidery_stitch', ''
  ] loop
    begin
      insert into public.production_unlocks
        (project_id, acquisition_session_id, production_profile, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session_a'),
         bad, 'active');
      raise exception 'PROOF 7 FAILED: production_profile "%" was accepted', bad;
    exception
      when check_violation then
        null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8. The status CHECK refuses payment-lifecycle and invented values.
-- ---------------------------------------------------------------------------

do $$
declare
  bad text;
begin
  foreach bad in array array['pending', 'paid', 'failed', 'expired', 'ACTIVE', ''] loop
    begin
      insert into public.production_unlocks
        (project_id, acquisition_session_id, production_profile, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session_a'),
         'apparel_raster', bad);
      raise exception 'PROOF 8 FAILED: status "%" was accepted', bad;
    exception
      when check_violation then
        null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Revocation consistency — the columns cannot contradict the status.
-- ---------------------------------------------------------------------------

do $$
begin
  -- 'revoked' with no timestamp: an audit trail that cannot say when.
  begin
    insert into public.production_unlocks
      (project_id, acquisition_session_id, production_profile, status, revoked_at)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session_a'),
       'apparel_raster', 'revoked', null);
    raise exception 'PROOF 9 FAILED: a revoked unlock with no revoked_at was accepted';
  exception when check_violation then null;
  end;

  -- 'active' carrying a revocation: indistinguishable afterwards from a real
  -- state, which is exactly when an audit trail stops being trustworthy.
  begin
    insert into public.production_unlocks
      (project_id, acquisition_session_id, production_profile, status, revoked_at)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session_a'),
       'apparel_raster', 'active', now());
    raise exception 'PROOF 9b FAILED: an active unlock stamped with revoked_at was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 10. ON DELETE RESTRICT on both foreign keys.
-- ---------------------------------------------------------------------------
--
-- Losing a row must never be the thing that changes what somebody is entitled
-- to. A cascade here would silently destroy the only durable evidence that a
-- project was ever paid for.

do $$
begin
  begin
    delete from public.print_projects
    where id = (select v from t_ids where k = 'project_2');
    raise exception 'PROOF 10 FAILED: a project with a production unlock was deletable';
  exception when foreign_key_violation then null;
  end;

  begin
    delete from public.acquisition_sessions
    where id = (select v from t_ids where k = 'session_a');
    raise exception 'PROOF 10b FAILED: an acquisition session with a production unlock was deletable';
  exception when foreign_key_violation then null;
  end;
end $$;

do $$
declare
  wrong text;
begin
  -- `confdeltype` is `"char"`, not text — cast explicitly, or `||` is
  -- ambiguous and the check fails to run at all.
  select string_agg(con.conname || '=' || con.confdeltype::text, ', ')
    into wrong
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public'
    and rel.relname = 'production_unlocks'
    and con.contype = 'f'
    and con.confdeltype::text <> 'r';  -- 'r' = RESTRICT

  if wrong is not null then
    raise exception 'PROOF 10c FAILED: foreign key(s) not ON DELETE RESTRICT: %', wrong;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 11. No permissive policy was introduced anywhere by this migration.
-- ---------------------------------------------------------------------------

do $$
declare
  offending text;
begin
  select string_agg(schemaname || '.' || tablename || '.' || policyname, ', ')
    into offending
  from pg_policies
  where schemaname = 'public'
    and (roles::text[] && array['anon', 'authenticated', 'public']);

  if offending is not null then
    raise exception 'PROOF 11 FAILED: browser-facing policy/policies exist: %', offending;
  end if;
end $$;

-- Nothing is committed. The proof is the assertions, not the rows.
rollback;

\echo 'ALL A5.1 PRODUCTION UNLOCK POSTGRES PROOFS PASSED'
