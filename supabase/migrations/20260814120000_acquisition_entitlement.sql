-- Sprint A4 — free-concept acquisition entitlement + email capture.
--
-- Additive and forward-only. Creates one new table and adds one nullable
-- column to an existing one. Nothing is renamed, rewritten, backfilled, or
-- deleted; no customer row is read or mutated by this migration.
--
-- WHY A MIGRATION IS REQUIRED
--
-- The acquisition funnel gives an anonymous prospect exactly ONE free
-- concept-generation attempt and then requires an email address to
-- continue. Both facts have to survive a page reload, a second browser tab,
-- a duplicate HTTP request, a worker reclaim, and a direct API call — so
-- neither can live in React state, `localStorage`, a cookie counter, or a
-- hidden field. They have to be server-authoritative and durable.
--
-- No existing table could carry them:
--
--   print_projects       one row per PROJECT. An entitlement stored here
--                        resets the moment the customer starts a second
--                        project, which is a one-click bypass.
--   generation_jobs      records what was requested, not who may request
--                        it, and is created only AFTER the authorization
--                        decision has already been made.
--   paid_image_intents   bounds spend WITHIN one already-authorized job.
--                        It cannot express "this prospect may authorize one
--                        job, ever".
--
-- And it could not be done race-safely without real database constraints:
-- the at-most-once guarantee rests on Postgres refusing a second claim, not
-- on application code reading before it writes.
--
-- WHAT THIS IS NOT
--
-- Not authentication. Not an account. Not a customer identity model. An
-- acquisition session is an opaque, server-issued bearer token whose only
-- purpose is spend control: it answers "has this browser session already
-- had its one free concept?" and nothing else. It carries no password, no
-- verified identity, no marketing consent, and no claim that an account
-- exists. Owner-scoped policies still arrive with real customer
-- authentication, as a separate architecture phase (see
-- 20260811191500_server_only_rls_lockdown.sql).
--
-- It is also explicitly NOT an anti-fraud platform. Clearing cookies,
-- switching browsers, or using another device produces a new session and a
-- new free concept. That limitation is stated in ARCHITECTURE.md rather
-- than papered over with device fingerprinting or IP-address identity,
-- neither of which this product will collect.

-- ---------------------------------------------------------------------------
-- 1. The acquisition session.
-- ---------------------------------------------------------------------------

create table if not exists public.acquisition_sessions (
  id uuid primary key default gen_random_uuid(),

  -- The opaque bearer value carried in an httpOnly cookie. Deliberately a
  -- separate column from `id`: the primary key is referenced by
  -- `print_projects.acquisition_session_id` and therefore travels through
  -- application joins, while this value is a credential. Keeping them apart
  -- means a future token rotation is an UPDATE of one column rather than a
  -- re-keying of the table.
  session_token text not null unique,

  -- The entitlement tier this session holds.
  --   'prospect' — an ordinary anonymous visitor: one free concept, then
  --                email, then (Sprint A5) payment.
  --   'internal' — explicitly granted server-side against a configured
  --                secret, for real Print'em All production work and
  --                acceptance testing. Auditable via `internal_granted_at`.
  -- No 'paid' value is introduced here. Payment entitlement is Sprint A5
  -- work and inventing a column for it now would create a value nothing can
  -- legitimately write.
  entitlement text not null default 'prospect'
    check (entitlement in ('prospect', 'internal')),

  -- The project this session's one free concept has been allocated to.
  -- Claimed atomically (NULL -> project id) at the moment concept
  -- generation is first authorized, BEFORE any generation job exists, so
  -- two racing requests cannot both be allocated.
  --
  -- Allocation alone is NOT consumption: a prospect whose enqueue failed
  -- before a durable job existed still has their free concept (see
  -- `free_concept_generation_job_id`).
  free_concept_project_id uuid null
    references public.print_projects (id) on delete set null,
  free_concept_allocated_at timestamptz null,

  -- The generation job that actually consumed the free concept. THIS is the
  -- irreversible consumption record: once set, the entitlement is spent and
  -- no second free generation is authorized for this session, ever.
  --
  -- Set only after `generation_jobs` insert succeeds — the point at which
  -- the platform has durably committed to a recoverable, idempotent,
  -- spend-bounded generation attempt. Before that point a failure is not
  -- the customer's fault and must not cost them their one free concept.
  free_concept_generation_job_id uuid null
    references public.generation_jobs (id) on delete set null,
  free_concept_consumed_at timestamptz null,

  -- Captured to continue the design session. NOT marketing consent, NOT a
  -- verified address, NOT an account. Stored normalized (trimmed,
  -- lowercased) so a duplicate submission is idempotent.
  email text null,
  email_captured_at timestamptz null,

  -- Audit trail for an internal-entitlement grant. Deliberately a timestamp
  -- rather than a boolean: "when did this happen" is the question an audit
  -- actually asks, and `entitlement` already answers "is it granted".
  internal_granted_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.acquisition_sessions is
  'Sprint A4: opaque anonymous acquisition session. Spend control for the one-free-concept funnel plus email capture. Not authentication, not an account, not marketing consent.';

comment on column public.acquisition_sessions.free_concept_project_id is
  'Sprint A4: the project this session''s free concept is ALLOCATED to. Atomic claim (NULL -> id). Allocation is not consumption.';

comment on column public.acquisition_sessions.free_concept_generation_job_id is
  'Sprint A4: the generation job that CONSUMED the free concept. Once set, the entitlement is irreversibly spent.';

comment on column public.acquisition_sessions.email is
  'Sprint A4: captured to continue the design session. Normalized (trimmed, lowercased). Never marketing consent; never verified; never implies an account exists.';

-- Lookup path for resolving a session from its cookie is already covered by
-- the UNIQUE constraint on `session_token`. No other index is added: every
-- other access is by primary key.

-- ---------------------------------------------------------------------------
-- 2. Bind a project to the session that created it.
-- ---------------------------------------------------------------------------
--
-- This is what makes the entitlement un-bypassable from the client. Every
-- paid-value gate resolves authority from the PROJECT, never from something
-- the caller supplied, so a request with a forged cookie, a cleared cookie,
-- or no cookie at all is still judged against the session that project
-- genuinely belongs to.
--
-- NULLABLE, with no default and no backfill, deliberately. NULL means
-- "created before acquisition sessions existed" — a legacy project, which
-- the application grandfathers so pre-A4 work keeps functioning. It does NOT
-- mean "unentitled", and it is not a hole: after this sprint every project
-- created through the API is bound at insert, so no new NULL row can appear
-- through a customer path. Writing a fabricated session id into historical
-- rows would assert an acquisition event that never happened, and would be
-- indistinguishable afterwards from a real one.
--
-- `on delete set null` rather than `cascade`: a session is spend
-- bookkeeping, and losing it must never delete a customer's design work.

alter table public.print_projects
  add column if not exists acquisition_session_id uuid null
    references public.acquisition_sessions (id) on delete set null;

comment on column public.print_projects.acquisition_session_id is
  'Sprint A4: the acquisition session that created this project — the server-side authority every paid-value gate resolves from. NULL = legacy project created before A4 (grandfathered), never "unentitled".';

create index if not exists print_projects_acquisition_session_idx
  on public.print_projects (acquisition_session_id)
  where acquisition_session_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Server-only RLS lockdown (see 20260811191500).
-- ---------------------------------------------------------------------------
--
-- Every application table is server-only. RLS with zero policies denies
-- every row to every non-bypassing role; `service_role` holds BYPASSRLS and
-- is unaffected. Revoking the Data API grants is the second, independent
-- control. This matters more here than on most tables: the rows contain
-- email addresses and the bearer tokens that gate spend.
--
-- No policy is added, for exactly the reason the lockdown migration states —
-- possession of a token is not identity, and a `using (true)` policy would
-- re-open the hole that migration closed.

alter table public.acquisition_sessions enable row level security;
revoke all privileges on table public.acquisition_sessions from anon, authenticated;
