-- Sprint A5.4 — verified payment events + THE ATOMIC ACTIVATION AUTHORITY.
--
-- Additive and forward-only. Creates one table and one function. Nothing is
-- renamed, rewritten, backfilled, or deleted. `production_unlocks` and
-- `payment_transactions` keep their existing semantics unchanged; this
-- migration only adds the one operation that may move a payment to `paid` and
-- an entitlement to `active` together.
--
-- THE AUTHORITY TRANSITION THIS MIGRATION EXISTS TO MAKE INDIVISIBLE
--
--   PaymentTransaction 'created'
--        ↓  VERIFIED provider webhook (signature checked against raw bytes)
--   PaymentEvent recorded
--        ↓  apply_payment_event()  ← ONE database transaction
--   PaymentTransaction 'paid'  +  ProductionUnlock 'active'
--        ↓
--   AcquisitionCapability.authorizeFinalization(projectId) allows
--
-- The browser redirect appears nowhere in that chain and cannot be inserted
-- into it: `?checkout=complete` reaches no code that writes to either table.
--
-- WHY A DATABASE FUNCTION AND NOT TWO APPLICATION WRITES
--
-- "Mark the transaction paid" and "create the unlock" are two statements
-- against two tables. Over the Supabase REST API they are two round trips,
-- and there is no way to put them in one transaction from the client. A crash
-- between them leaves exactly the two states this product must never be in:
--
--   paid, no unlock    the customer was charged and cannot produce anything.
--   unlock, not paid   the platform gave away production reconstruction and
--                      has no record of being paid for it.
--
-- No ordering fixes this, for the same reason Sprint A4 Correction 1 could
-- not fix the free-concept window by reordering writes: the guarantee has to
-- be a property of the database, not of the sequence the application happened
-- to attempt. So the whole transition is one function, and PostgreSQL's
-- transaction is the atomicity.
--
-- WHAT THIS FUNCTION IS NOT: a general update endpoint. It takes no table
-- name, no column name, no project id, no acquisition session id, no
-- production profile, and no SQL. Every fact about WHAT is being unlocked is
-- read from the durable `payment_transactions` row inside the function.
-- Provider data may only ever be COMPARED against what is already stored,
-- never used to establish it.

-- ---------------------------------------------------------------------------
-- 1. The payment event.
-- ---------------------------------------------------------------------------

create table if not exists public.payment_events (
  id uuid primary key default gen_random_uuid(),

  provider text not null
    check (provider in ('stripe')),

  -- THE IDEMPOTENCY FENCE.
  --
  -- A payment provider retries a webhook until it receives a 2xx, and a
  -- network partition means a retry can arrive while the first delivery is
  -- still in flight. This UNIQUE constraint is what makes duplicate delivery
  -- harmless: the insert is taken FIRST, inside the same transaction as the
  -- payment application, so a concurrent duplicate blocks on this index and
  -- then finds the conflict. It never "reads, sees nothing, and proceeds",
  -- which is the pattern that lets two deliveries both grant an entitlement.
  provider_event_id text not null unique,

  -- The provider's own event type, verbatim, for operational forensics. No
  -- gate branches on this after the fact — `outcome` below records what the
  -- platform actually DID, which is a different question.
  event_type text not null,

  -- SHA-256 (hex) of the exact raw bytes whose signature was verified.
  --
  -- THE RAW PAYLOAD IS DELIBERATELY NOT STORED. A provider event body carries
  -- the customer's email and billing address, card brand and last four,
  -- provider customer/account identifiers, and amounts. None of it is needed
  -- after reconciliation, and storing it would create a durable copy of
  -- payment PII in the application database — a copy that outlives the
  -- purchase, appears in every backup, and has to be protected forever.
  --
  -- A digest keeps the only property that is actually useful later: proof
  -- that a specific body was the one processed. It is useless for
  -- reconstructing what was in it.
  payload_digest text not null
    check (payload_digest ~ '^[0-9a-f]{64}$'),

  received_at timestamptz not null default now(),

  --   'processed'         acted on: a payment applied, or a stale attempt
  --                       expired. The only outcome that ever accompanies a
  --                       commercial state change.
  --   'ignored'           validly signed, deliberately not acted on.
  --   'unmatched'         no payment transaction resolved. Provider metadata
  --                       never bootstraps a purchase.
  --   'rejected_mismatch' a transaction was found and reconciliation FAILED.
  --                       Nothing was mutated.
  --
  -- Deliberately the PLATFORM's vocabulary, not the provider's. Putting
  -- 'checkout.session.completed' here would make the schema track a third
  -- party's taxonomy forever.
  outcome text not null
    check (outcome in ('processed', 'ignored', 'unmatched', 'rejected_mismatch')),

  processed_at timestamptz null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.payment_events is
  'Sprint A5.4: one VERIFIED provider webhook event and what the platform did about it. provider_event_id UNIQUE is the idempotency authority — the insert participates in the same transaction as the payment application, so duplicate delivery cannot grant twice. Stores a SHA-256 digest of the verified bytes, never the raw payload (which carries payment PII).';

comment on column public.payment_events.payload_digest is
  'Sprint A5.4: SHA-256 (hex) of the exact raw bytes whose signature was verified. Proves afterwards which body was processed; useless for reconstructing its contents. The raw payload is never stored.';

comment on column public.payment_events.outcome is
  'Sprint A5.4: what the PLATFORM did — deliberately not the provider event type (which is in event_type). Only ''processed'' ever accompanies a commercial state change.';

create index if not exists payment_events_received_at_idx
  on public.payment_events (received_at desc);

-- ---------------------------------------------------------------------------
-- 2. Server-only RLS lockdown (see 20260811191500).
-- ---------------------------------------------------------------------------
--
-- Same convention as every other application table. This one matters
-- particularly: a browser that could INSERT here would be able to
-- manufacture the idempotency fence, and one that could read it would learn
-- the platform's payment cadence.

alter table public.payment_events enable row level security;
revoke all privileges on table public.payment_events from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. THE ATOMIC ACTIVATION AUTHORITY.
-- ---------------------------------------------------------------------------
--
-- SECURITY MODEL, stated explicitly because a payment function is exactly the
-- place a privilege mistake is worth making loudly:
--
--   * SECURITY INVOKER — the default, and deliberately NOT `SECURITY
--     DEFINER`. The only role that calls this is `service_role`, which
--     already holds BYPASSRLS and full privileges on all three tables it
--     touches, so `DEFINER` would buy nothing and would create a standing
--     privilege-escalation path through a function that moves money. If a
--     caller cannot write these tables directly, it has no business
--     completing a payment.
--
--   * `search_path` is pinned so the function cannot be redirected to
--     shadowed tables by a caller-controlled path, and every table is
--     schema-qualified anyway.
--
--   * NO DYNAMIC SQL. No table, column, or predicate is caller-selected;
--     `p_action` is a closed enum validated on entry. There is nothing here
--     to inject into.
--
--   * EXECUTE IS REVOKED FROM PUBLIC. PostgreSQL grants EXECUTE on new
--     functions to PUBLIC by default, which would make this callable by
--     `anon` and `authenticated` through PostgREST — the single most
--     dangerous default in this migration. It is revoked explicitly below,
--     and the accompanying proof asserts the revocation against a live
--     database rather than trusting that this comment stayed true.
--
-- WHAT IT MAY AND MAY NOT BE TOLD:
--
--   MAY   the event's identity and digest, which transaction it claims to be
--         about, and the provider's reported session/intent/amount/currency —
--         all of which are only ever COMPARED against stored values.
--
--   MAY NOT   project id, acquisition session id, or production profile.
--         Those are read from the transaction row. A webhook that could
--         supply them could unlock a different customer's project.

create or replace function public.apply_payment_event(
  p_provider text,
  p_provider_event_id text,
  p_event_type text,
  p_payload_digest text,
  -- Closed vocabulary: 'activate' (a paid checkout), 'expire' (a lapsed
  -- checkout), 'ignore' (validly signed, not acted on).
  p_action text,
  -- NULL for 'ignore'.
  p_payment_transaction_id uuid,
  p_provider_checkout_session_id text,
  p_provider_payment_intent_id text,
  p_amount_minor integer,
  p_currency text
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_txn public.payment_transactions%rowtype;
  v_outcome text;
begin
  if p_action not in ('activate', 'expire', 'ignore') then
    raise exception 'apply_payment_event: unknown action %', p_action
      using errcode = 'invalid_parameter_value';
  end if;

  -- (1) THE IDEMPOTENCY FENCE, taken first and inside this transaction.
  --
  -- A concurrent duplicate delivery blocks on the unique index here until
  -- this transaction commits or rolls back. On commit it sees the conflict
  -- and returns 'duplicate'; on rollback it proceeds and does the work
  -- itself. Neither can half-apply, and neither needs an application-level
  -- "check whether we have seen this" read — which is precisely the pattern
  -- that lets two deliveries both pass.
  --
  -- Inserted with a provisional 'ignored' outcome and corrected below. The
  -- column is NOT NULL and the honest answer is not known yet; 'ignored'
  -- is the safe provisional value because it is the one that claims nothing.
  insert into public.payment_events
    (provider, provider_event_id, event_type, payload_digest, outcome)
  values
    (p_provider, p_provider_event_id, p_event_type, p_payload_digest, 'ignored')
  on conflict (provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    return 'duplicate';
  end if;

  if p_action = 'ignore' then
    update public.payment_events
    set outcome = 'ignored', processed_at = now(), updated_at = now()
    where id = v_event_id;
    return 'ignored';
  end if;

  -- (2) Resolve the transaction and LOCK it for the rest of this
  -- transaction, so a concurrent event for the same payment serializes
  -- behind us rather than reading stale state.
  select * into v_txn
  from public.payment_transactions
  where id = p_payment_transaction_id
  for update;

  if not found then
    -- Provider metadata NEVER bootstraps a purchase. An event naming a
    -- transaction we have no record of is recorded and dropped.
    update public.payment_events
    set outcome = 'unmatched', processed_at = now(), updated_at = now()
    where id = v_event_id;
    return 'unmatched';
  end if;

  -- (3) Reconciliation. Every check compares provider-reported data against
  -- what is ALREADY STORED. Nothing here can establish a new fact.
  --
  -- The checkout session must match. Trusting the internal transaction id
  -- from metadata while ignoring the session id would mean a single
  -- mislabelled metadata value could pay off a different transaction.
  if v_txn.provider_checkout_session_id is distinct from p_provider_checkout_session_id then
    update public.payment_events
    set outcome = 'rejected_mismatch', processed_at = now(), updated_at = now()
    where id = v_event_id;
    return 'rejected_mismatch';
  end if;

  if p_action = 'expire' then
    -- A PAID transaction is NEVER downgraded by a later or out-of-order
    -- lapse notification. Money that arrived does not un-arrive because a
    -- session object expired.
    if v_txn.status in ('pending_provider', 'created') then
      update public.payment_transactions
      set status = 'expired', updated_at = now()
      where id = v_txn.id;
      v_outcome := 'processed';
    else
      v_outcome := 'ignored';
    end if;

    update public.payment_events
    set outcome = v_outcome, processed_at = now(), updated_at = now()
    where id = v_event_id;
    return v_outcome;
  end if;

  -- (4) 'activate' — the money path.
  --
  -- Amount and currency must match EXACTLY: no conversion, no rounding, no
  -- tolerance. A provider reporting a different figure than the one this
  -- platform quoted is not a rounding artefact, it is a reconciliation
  -- failure, and the correct response is to refuse and let a human look.
  if v_txn.amount_minor is distinct from p_amount_minor
     or v_txn.currency is distinct from p_currency then
    update public.payment_events
    set outcome = 'rejected_mismatch', processed_at = now(), updated_at = now()
    where id = v_event_id;
    return 'rejected_mismatch';
  end if;

  -- Which states may be activated, stated positively so a status this build
  -- has never heard of can never pass:
  --
  --   'created'  the ordinary path.
  --   'expired'  an out-of-order lapse arrived before the completion. The
  --              money is real; our bookkeeping was merely early.
  --   'paid'     a second distinct event for the same payment (Stripe emits
  --              more than one event type per checkout). Idempotent — the
  --              unlock below is reused, never duplicated.
  --
  -- Deliberately NOT 'pending_provider' (no session was ever bound, so the
  -- session check above has already refused it), not 'failed', and not
  -- 'refunded' — re-activating a refunded purchase would hand back an
  -- entitlement somebody was already given their money back for.
  if v_txn.status not in ('created', 'expired', 'paid') then
    update public.payment_events
    set outcome = 'rejected_mismatch', processed_at = now(), updated_at = now()
    where id = v_event_id;
    return 'rejected_mismatch';
  end if;

  -- Bind the payment intent. The UNIQUE constraint on the column is an
  -- independent second fence: one provider payment intent can never pay off
  -- two iHeartPrints transactions. A violation is a reconciliation failure,
  -- not an infrastructure fault, so it is caught and reported rather than
  -- raised — raising would make the provider retry forever against a state
  -- that will never become valid.
  if p_provider_payment_intent_id is not null then
    begin
      update public.payment_transactions
      set provider_payment_intent_id = p_provider_payment_intent_id,
          updated_at = now()
      where id = v_txn.id
        and (provider_payment_intent_id is null
             or provider_payment_intent_id = p_provider_payment_intent_id);
    exception when unique_violation then
      update public.payment_events
      set outcome = 'rejected_mismatch', processed_at = now(), updated_at = now()
      where id = v_event_id;
      return 'rejected_mismatch';
    end;
  end if;

  update public.payment_transactions
  set status = 'paid', updated_at = now()
  where id = v_txn.id;

  -- THE ENTITLEMENT, derived ENTIRELY from the transaction row. The webhook
  -- never told us which project, which session, or which profile — it could
  -- not, because this function was never given them.
  --
  -- `on conflict do nothing` against the partial unique index makes this
  -- reuse an already-active unlock rather than duplicating one, which is what
  -- makes two distinct events for the same payment converge.
  insert into public.production_unlocks
    (project_id, acquisition_session_id, production_profile, status)
  values
    (v_txn.project_id, v_txn.acquisition_session_id, v_txn.production_profile, 'active')
  on conflict do nothing;

  update public.payment_events
  set outcome = 'processed', processed_at = now(), updated_at = now()
  where id = v_event_id;

  return 'processed';
end;
$$;

comment on function public.apply_payment_event(text, text, text, text, text, uuid, text, text, integer, text) is
  'Sprint A5.4: THE atomic payment→entitlement transition. Records the verified event (provider_event_id UNIQUE is the idempotency fence), reconciles provider-reported data against the stored payment_transactions row, and — only if every check passes — marks the transaction paid and activates the production unlock IN ONE TRANSACTION. Derives project/session/profile from the transaction row; they are deliberately not parameters. SECURITY INVOKER, pinned search_path, no dynamic SQL, EXECUTE revoked from PUBLIC.';

-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default. For a
-- function that completes payments and activates entitlements that default is
-- the single most dangerous line in this migration — through PostgREST it
-- would be callable by `anon`. Revoked explicitly, and asserted against a live
-- database by `scripts/verify-payment-events-postgres.sql`.
revoke all on function public.apply_payment_event(text, text, text, text, text, uuid, text, text, integer, text)
  from public, anon, authenticated;
