-- Server-Only RLS Lockdown for all public application tables.
--
-- INCIDENT
--
-- A read-only security audit proved that all twelve public-schema
-- application tables had RLS disabled, no policies, and full table
-- privileges granted to both `anon` and `authenticated`. Anonymous SELECT
-- through PostgREST returned real application data on every one of them,
-- using both the legacy `anon` key and the newer publishable key — either of
-- which any visitor can read out of a browser bundle. Project UUIDs are not
-- secrets and were never an authorization boundary; possession of one is not
-- identity.
--
-- WHY THERE ARE NO POLICIES HERE
--
-- This application's data access contract is, today, SERVER ONLY:
--
--   Browser -> Next.js route -> server repository -> Supabase service role
--
-- Nothing in the browser talks to PostgREST. There is no customer identity
-- model yet: `print_projects` has no `owner_user_id`, `user_id`, `tenant_id`,
-- or `organization_id`, and no other table carries one either. So there is no
-- honest predicate an owner policy could be written against.
--
-- Enabling RLS with ZERO policies is therefore not an oversight, it is the
-- correct expression of the current contract: RLS with no policy denies every
-- row to every non-bypassing role. `service_role` holds BYPASSRLS and is
-- unaffected, which is precisely why the server keeps working.
--
-- What was deliberately NOT done, and must not be added later "to quiet the
-- Advisor":
--
--   * `using (true)` or any other permissive policy — that would re-open
--     exactly the hole this migration closes.
--   * A policy keyed on a project UUID — knowing an id is not being its
--     owner.
--   * An invented `owner_user_id` column — fabricating an ownership column
--     with nothing to populate it produces a policy that is either
--     always-false (breaking the app) or trivially bypassed.
--
-- Owner-scoped policies arrive with real customer authentication, as a
-- separate architecture phase. See `ARCHITECTURE.md`, Current Data Access
-- Model.
--
-- Additive, forward-only, and idempotent: enabling RLS on a table that
-- already has it and revoking a privilege that is already absent are both
-- no-ops. No row is read, rewritten, or deleted by this migration.

-- ---------------------------------------------------------------------------
-- 1. Enable row level security on every application table.
-- ---------------------------------------------------------------------------

alter table public.print_projects enable row level security;
alter table public.tshirt_design_briefs enable row level security;
alter table public.design_conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.artwork_versions enable row level security;
alter table public.design_brief_versions enable row level security;
alter table public.generation_jobs enable row level security;
alter table public.assets enable row level security;
alter table public.final_direction_approvals enable row level security;
alter table public.final_artwork_jobs enable row level security;
alter table public.production_asset_validations enable row level security;
alter table public.artwork_preparations enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Defense in depth: remove the Data API table privileges themselves.
--
-- RLS alone would already deny every row. Revoking the underlying grants
-- means a future permissive policy, added by mistake, still cannot expose
-- these tables to a browser key — the role has no privilege on the relation
-- to exercise in the first place. Two independent controls, both of which
-- must fail before data leaks.
--
-- Scoped explicitly to these twelve tables. `service_role` is untouched, as
-- are all Supabase-managed schemas (auth, storage, realtime, ...).
-- ---------------------------------------------------------------------------

revoke all privileges on table public.print_projects from anon, authenticated;
revoke all privileges on table public.tshirt_design_briefs from anon, authenticated;
revoke all privileges on table public.design_conversations from anon, authenticated;
revoke all privileges on table public.conversation_messages from anon, authenticated;
revoke all privileges on table public.artwork_versions from anon, authenticated;
revoke all privileges on table public.design_brief_versions from anon, authenticated;
revoke all privileges on table public.generation_jobs from anon, authenticated;
revoke all privileges on table public.assets from anon, authenticated;
revoke all privileges on table public.final_direction_approvals from anon, authenticated;
revoke all privileges on table public.final_artwork_jobs from anon, authenticated;
revoke all privileges on table public.production_asset_validations from anon, authenticated;
revoke all privileges on table public.artwork_preparations from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Future tables (table #13).
--
-- `alter default privileges` is per-ROLE, and applying it under the wrong
-- role is a silent no-op that reads like protection. So the owning role is
-- DISCOVERED from an existing application table rather than assumed to be
-- `postgres`, and the result is reported as a NOTICE in the `db push` output
-- so it is auditable rather than taken on faith.
--
-- If the migration role is not a member of the owning role, Postgres refuses
-- the statement. That is caught and reported instead of failing the
-- migration, because the AUTHORITATIVE guarantee against a future unprotected
-- table is not this block — it is the offline convention test
-- `src/lib/db/security-lockdown.migration.test.ts`, which fails
-- `npm run verify` the moment a migration creates a public table without
-- enabling RLS and revoking anon/authenticated privileges. That test cannot
-- be bypassed by a role technicality, and it fires before the change ever
-- reaches a database.
-- ---------------------------------------------------------------------------

do $$
declare
  owning_role name;
begin
  select pg_get_userbyid(relowner)
    into owning_role
    from pg_class
   where oid = 'public.print_projects'::regclass;

  raise notice 'server_only_rls_lockdown: application tables are owned by role %', owning_role;

  begin
    execute format(
      'alter default privileges for role %I in schema public revoke all on tables from anon, authenticated',
      owning_role
    );
    execute format(
      'alter default privileges for role %I in schema public revoke all on sequences from anon, authenticated',
      owning_role
    );
    raise notice 'server_only_rls_lockdown: default privileges locked down for role %', owning_role;
  exception
    when insufficient_privilege then
      raise notice 'server_only_rls_lockdown: NOT a member of role %, default privileges unchanged; the offline convention test remains the guarantee', owning_role;
  end;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Self-verification.
--
-- This migration asserts its own postconditions against the live catalog and
-- aborts the transaction if any one of them does not hold. Verification of a
-- security control should not depend on someone remembering to run a query
-- afterwards, or on the SQL above merely LOOKING correct.
-- ---------------------------------------------------------------------------

do $$
declare
  application_tables constant text[] := array[
    'print_projects',
    'tshirt_design_briefs',
    'design_conversations',
    'conversation_messages',
    'artwork_versions',
    'design_brief_versions',
    'generation_jobs',
    'assets',
    'final_direction_approvals',
    'final_artwork_jobs',
    'production_asset_validations',
    'artwork_preparations'
  ];
  table_name text;
  offenders text;
begin
  -- (a) RLS is on for all twelve.
  select string_agg(c.relname, ', ' order by c.relname)
    into offenders
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any(application_tables)
     and c.relrowsecurity is false;

  if offenders is not null then
    raise exception 'server_only_rls_lockdown: RLS not enabled on: %', offenders;
  end if;

  -- (b) All twelve actually exist (a typo above would otherwise pass (a) by
  --     matching nothing at all).
  foreach table_name in array application_tables loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'server_only_rls_lockdown: expected table public.% does not exist', table_name;
    end if;
  end loop;

  -- (c) No policy grants anon or authenticated anything.
  select string_agg(format('%s.%s', tablename, policyname), ', ')
    into offenders
    from pg_policies
   where schemaname = 'public'
     and tablename = any(application_tables)
     and (roles && array['anon', 'authenticated']::name[]
          or roles && array['public']::name[]);

  if offenders is not null then
    raise exception 'server_only_rls_lockdown: unexpected anon/authenticated/public policy: %', offenders;
  end if;

  -- (d) No table privileges remain for the browser-facing roles.
  select string_agg(
           format('%s:%s:%s', g.grantee, g.table_name, g.privilege_type),
           ', '
         )
    into offenders
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name = any(application_tables)
     and g.grantee in ('anon', 'authenticated');

  if offenders is not null then
    raise exception 'server_only_rls_lockdown: anon/authenticated privileges remain: %', offenders;
  end if;

  raise notice 'server_only_rls_lockdown: verified — 12 tables, RLS on, no anon/authenticated policies or privileges';
end
$$;
