-- Sprint A5.3 — payment transactions (one checkout / payment attempt).
--
-- Additive and forward-only. Creates one new table. Nothing is renamed,
-- rewritten, backfilled, or deleted. `production_unlocks` is NOT modified.
--
-- WHAT THIS RECORD IS, AND WHAT IT IS EMPHATICALLY NOT
--
-- A `payment_transactions` row records that somebody was sent to a payment
-- page for one project, and what happened next. It is the ATTEMPT.
--
-- It is NEVER the entitlement. `production_unlocks` (§23c) remains the only
-- thing that authorizes production preparation, and no status in this
-- table — not even the `'paid'` this sprint does not write — will ever be
-- read as permission. That separation is what makes "the browser came back
-- from Stripe" structurally incapable of unlocking a project: the redirect
-- touches nothing, and even the verified webhook A5.4 adds will write an
-- unlock row rather than reinterpret a transaction status.
--
-- The provider ids here are RECONCILIATION HANDLES, not authority. They
-- exist so a verified webhook can find the row it is talking about.
-- Possession of one proves nothing — anybody can read a Stripe id out of a
-- redirect URL.
--
-- WHY `pending_provider` EXISTS, which is the whole design of this table
--
-- A durable row has to exist BEFORE the payment provider is called, because
-- the provider needs our internal transaction id as its idempotency key and
-- as the metadata handle a later webhook reconciles through. At that instant
-- no checkout session exists anywhere.
--
-- Calling that state `'created'` would be a lie, and a crash would make it a
-- permanent one: a row claiming a checkout that was never created, holding
-- the outstanding-attempt slot forever, with nothing able to tell it apart
-- from a real one afterwards. So the pre-provider state is named honestly
-- and is RESUMABLE — retrying replays the same idempotency key, and the
-- provider returns the same session rather than a second one.
--
-- Stripe and PostgreSQL cannot be made atomic. This schema does not pretend
-- otherwise; it makes the durable state converge instead:
--
--   crash after the provider call succeeds, before we persist the id
--       → row stays `pending_provider`; the retry replays the same
--         idempotency key and binds the SAME session.
--   provider call fails, provably before dispatch
--       → row moves to `failed`, freeing the slot for a fresh attempt.
--   provider call fails ambiguously
--       → row STAYS `pending_provider`. A second checkout must not start
--         alongside a session that may really exist; the retry resumes it.
--
-- WHY A MIGRATION IS REQUIRED
--
-- "At most one outstanding checkout attempt per project and profile" has to
-- be enforced by PostgreSQL, not by application code reading before it
-- writes. Two tabs, a double click, or a duplicated request must not produce
-- two live payment pages for one purchase — and under concurrency only a
-- constraint can guarantee that. Same rule as
-- `acquisition_free_concept_claims` and `production_unlocks`: the refusal IS
-- the guarantee.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT ADD
--
--   No `payment_events` table. Webhook receipt and event idempotency are
--   A5.4's authority and belong in A5.4's migration; creating the table now
--   would leave an empty table whose only documented purpose is a thing
--   nothing implements.
--
--   No change to `production_unlocks`, and no foreign key from a transaction
--   to an unlock. Checkout does not grant entitlement, so there is nothing
--   to point at yet, and a nullable unlock id sitting on a transaction is
--   exactly the sort of column a future reader mistakes for authority.
--
--   No approval / artwork-version provenance. The purchase is project-keyed
--   (§23c); recording the approval that motivated it would be write-only in
--   this slice and is a standing invitation to bind to it later.

-- ---------------------------------------------------------------------------
-- 1. The payment transaction.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),

  -- The project this attempt would unlock — always the entitlement key, so
  -- a transaction can never be about "whatever design is selected".
  --
  -- ON DELETE RESTRICT, matching every acquisition and unlock foreign key:
  -- losing a row must never destroy the record of money having been asked
  -- for, and financial history is precisely the thing a cascade must not
  -- silently take with it.
  project_id uuid not null
    references public.print_projects (id) on delete restrict,

  -- WHO the buyer is, resolved server-side from the PROJECT's own durable
  -- binding — never from a cookie, a header, or a request body.
  --
  -- NOT NULL, which is also why a legacy project (acquisition_session_id IS
  -- NULL) cannot check out: there is no buyer to record, and fabricating one
  -- would invent an identity the product never captured.
  acquisition_session_id uuid not null
    references public.acquisition_sessions (id) on delete restrict,

  -- Frozen at creation from server configuration. Must agree with the
  -- profile the resulting `production_unlocks` row will carry — the same
  -- grantable-subset CHECK as 20260816120000, for the same reason: a string
  -- in a column must never be what selects a production path.
  production_profile text not null
    check (production_profile in ('apparel_raster')),

  provider text not null
    check (provider in ('stripe')),

  -- Reconciliation handles. NULL until the provider genuinely issues them —
  -- the payment intent often does not exist until the customer actually
  -- pays, which is why it is separately nullable.
  --
  -- UNIQUE on both: one provider session belongs to exactly one attempt, so
  -- a webhook can never resolve to two rows, and a bug that tried to bind
  -- one session to two transactions is refused rather than silently
  -- creating an ambiguity a human would have to untangle later. Postgres
  -- UNIQUE permits many NULLs, so unbound rows are unconstrained.
  provider_checkout_session_id text null unique,
  provider_payment_intent_id text null unique,

  -- Where to send the customer. Stored rather than re-derived so a repeat
  -- request reuses the SAME live session instead of creating a second one.
  -- Provider-issued, short-lived, and not a secret.
  provider_checkout_url text null,

  -- Frozen at creation and never re-read from configuration afterwards: a
  -- price change must not retroactively rewrite what somebody was charged.
  amount_minor integer not null check (amount_minor > 0),
  -- Lowercase ISO 4217. The shape is constrained rather than the membership:
  -- enumerating world currencies in a CHECK would be a maintenance trap, and
  -- the real defence is that this value comes from server configuration and
  -- never from a request.
  currency text not null check (currency ~ '^[a-z]{3}$'),

  --   'pending_provider' — durable intent; nothing exists at the provider
  --                        yet, or the attempt ended ambiguously. Resumable.
  --   'created'          — a provider checkout session genuinely exists.
  --                        NOT payment; authorizes nothing.
  --   'failed'           — provably never created a provider session.
  --   'paid'/'expired'/'refunded' — A5.4+ only. Present in the vocabulary so
  --                        the schema need not change to record them; NOT
  --                        written by anything in A5.3.
  status text not null
    check (status in ('pending_provider', 'created', 'failed', 'paid', 'expired', 'refunded')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A `created` row must actually be usable. Without this, a partial bind
  -- could leave a transaction claiming a checkout exists with nowhere to
  -- send the customer — and the application would have to defend against a
  -- state the database could simply refuse.
  constraint payment_transactions_created_is_bound check (
    status <> 'created'
    or (provider_checkout_session_id is not null and provider_checkout_url is not null)
  ),

  -- And the mirror: the pre-provider state must not claim a session.
  -- Together these two make `pending_provider` and `created` genuinely
  -- distinct facts rather than a flag somebody could forget to move.
  constraint payment_transactions_pending_is_unbound check (
    status <> 'pending_provider'
    or (provider_checkout_session_id is null and provider_checkout_url is null)
  )
);

comment on table public.payment_transactions is
  'Sprint A5.3: ONE checkout/payment attempt for one project and production profile. The ATTEMPT, never the entitlement — production_unlocks remains the sole authority for whether a project may be prepared for production, and no status here is ever read as permission. Provider ids are reconciliation handles, not authority.';

comment on column public.payment_transactions.status is
  'Sprint A5.3: pending_provider = durable intent, nothing at the provider yet, resumable via the same idempotency key. created = a provider session genuinely exists (NOT payment). failed = provably never dispatched. paid/expired/refunded are A5.4+ vocabulary and are written by nothing in A5.3.';

comment on column public.payment_transactions.provider_checkout_session_id is
  'Sprint A5.3: reconciliation handle so a VERIFIED webhook can find this row. Never authority — anybody can read a provider id out of a redirect URL. UNIQUE so one provider session can never resolve to two attempts.';

comment on column public.payment_transactions.amount_minor is
  'Sprint A5.3: frozen at creation from server-authoritative configuration. Never supplied by a browser, and never re-read from config afterwards — a price change must not rewrite what somebody was charged.';

-- ---------------------------------------------------------------------------
-- 2. THE OUTSTANDING-ATTEMPT INVARIANT.
-- ---------------------------------------------------------------------------
--
-- At most ONE outstanding checkout attempt per (project, production profile),
-- enforced by PostgreSQL. Two tabs, a double click, a duplicated request, and
-- (in A5.4) a retried webhook all resolve against this rather than against
-- application code that read before it wrote.
--
-- The predicate deliberately includes `pending_provider`. An attempt whose
-- provider call ended ambiguously may correspond to a real, live checkout
-- session we simply failed to record; letting a second attempt start
-- alongside it is exactly how a customer ends up looking at two payment
-- pages for one purchase. The resume path replays the same idempotency key
-- instead.
--
-- Terminal rows (`failed`, `paid`, `expired`, `refunded`) do not occupy the
-- slot, so history accumulates and a genuinely new attempt is always
-- possible — the same shape as `production_unlocks`' active-only index.

create unique index if not exists payment_transactions_outstanding_per_project_profile_idx
  on public.payment_transactions (project_id, production_profile)
  where status in ('pending_provider', 'created');

-- Reverse lookups: "what has this session attempted" (support/analytics) and
-- "every attempt for this project, newest first". Neither is unique — a
-- project legitimately accumulates terminal attempts over time.
create index if not exists payment_transactions_acquisition_session_idx
  on public.payment_transactions (acquisition_session_id);

create index if not exists payment_transactions_project_created_at_idx
  on public.payment_transactions (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Server-only RLS lockdown (see 20260811191500).
-- ---------------------------------------------------------------------------
--
-- The convention every new application table follows: RLS enabled with ZERO
-- policies denies every row to every non-bypassing role, and revoking the
-- Data API grants is the second, independent control. `service_role` holds
-- BYPASSRLS and is unaffected.
--
-- This is the most sensitive table added so far. The rows carry amounts, a
-- buyer's session binding, and live provider checkout URLs — a browser that
-- could read them would be handed other customers' payment pages, and one
-- that could write them would be able to manufacture the reconciliation
-- handles A5.4's webhook resolves through.
--
-- No policy is added. There is still no customer identity model, so there is
-- still no owner-scoped policy that could be written honestly.

alter table public.payment_transactions enable row level security;
revoke all privileges on table public.payment_transactions from anon, authenticated;
