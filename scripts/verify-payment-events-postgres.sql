-- Sprint A5.4 — REAL POSTGRESQL PROOF for `payment_events` and the atomic
-- `apply_payment_event` authority.
--
-- ATOMICITY IS NOT PROVEN BY READING CODE. Every claim below is executed
-- against a live database with the complete migration chain applied, and each
-- assertion raises if the invariant does not hold — so a passing run means
-- every one actually ran.
--
-- Nothing here touches production. No provider is contacted. No customer data
-- is read.
--
--   docker run -d --name ihp-a54 -e POSTGRES_PASSWORD=proof postgres:16
--   docker exec ihp-a54 psql -U postgres -c \
--     "create role anon nologin; create role authenticated nologin; \
--      create role service_role nologin bypassrls;"
--   docker exec ihp-a54 createdb -U postgres ihp
--   docker exec ihp-a54 psql -U postgres -d ihp -c "
--     create schema storage;
--     create table storage.buckets (id text primary key, name text, public boolean);
--     grant usage on schema public to anon, authenticated, service_role;
--     alter default privileges in schema public grant all on tables to service_role;
--     alter default privileges in schema public grant all on functions to service_role;"
--   -- apply supabase/migrations/*.sql in filename order, then this file.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

create temporary table t_ids (k text primary key, v uuid);

with s as (
  insert into public.acquisition_sessions (session_token)
  values ('a54-proof-session') returning id
)
insert into t_ids select 'session', id from s;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5.4 proof project 1', 'intake', (select v from t_ids where k = 'session'))
  returning id
)
insert into t_ids select 'project_1', id from p;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5.4 proof project 2', 'intake', (select v from t_ids where k = 'session'))
  returning id
)
insert into t_ids select 'project_2', id from p;

-- (A) A created payment transaction exists — the precondition everything else
--     is about.
with x as (
  insert into public.payment_transactions
    (project_id, acquisition_session_id, production_profile, provider,
     amount_minor, currency, status, provider_checkout_session_id,
     provider_checkout_url)
  values
    ((select v from t_ids where k = 'project_1'),
     (select v from t_ids where k = 'session'),
     'apparel_raster', 'stripe', 4900, 'usd', 'created',
     'cs_proof_1', 'https://checkout.example/1')
  returning id
)
insert into t_ids select 'txn_1', id from x;

with x as (
  insert into public.payment_transactions
    (project_id, acquisition_session_id, production_profile, provider,
     amount_minor, currency, status, provider_checkout_session_id,
     provider_checkout_url)
  values
    ((select v from t_ids where k = 'project_2'),
     (select v from t_ids where k = 'session'),
     'apparel_raster', 'stripe', 4900, 'usd', 'created',
     'cs_proof_2', 'https://checkout.example/2')
  returning id
)
insert into t_ids select 'txn_2', id from x;

do $$
begin
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_1')) <> 'created' then
    raise exception 'PROOF A FAILED: fixture transaction is not in status created';
  end if;
  if (select count(*) from public.production_unlocks) <> 0 then
    raise exception 'PROOF A FAILED: an unlock exists before any payment event';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (B) A valid reconciliation pays the transaction, activates ONE unlock, and
--     records the event as processed — together.
-- ---------------------------------------------------------------------------

do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_B', 'checkout.session.completed', repeat('a', 64),
    'activate', (select v from t_ids where k = 'txn_1'),
    'cs_proof_1', 'pi_proof_1', 4900, 'usd');

  if v_result <> 'processed' then
    raise exception 'PROOF B FAILED: expected processed, got %', v_result;
  end if;

  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_1')) <> 'paid' then
    raise exception 'PROOF B FAILED: transaction was not marked paid';
  end if;

  if (select provider_payment_intent_id from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_1')) <> 'pi_proof_1' then
    raise exception 'PROOF B FAILED: payment intent was not bound';
  end if;

  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_1')
        and status = 'active') <> 1 then
    raise exception 'PROOF B FAILED: expected exactly one active unlock';
  end if;

  -- Derived from the TRANSACTION row: the function was never given a project,
  -- a session, or a profile.
  if not exists (
    select 1 from public.production_unlocks
    where project_id = (select v from t_ids where k = 'project_1')
      and acquisition_session_id = (select v from t_ids where k = 'session')
      and production_profile = 'apparel_raster'
      and status = 'active'
  ) then
    raise exception 'PROOF B FAILED: unlock was not derived from the transaction row';
  end if;

  if (select outcome from public.payment_events where provider_event_id = 'evt_B')
     <> 'processed' then
    raise exception 'PROOF B FAILED: event outcome is not processed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (C) + (E) Repeating the EXACT operation is idempotent: still one unlock, and
--     the duplicate is reported as such rather than doing the work again.
-- ---------------------------------------------------------------------------

do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_B', 'checkout.session.completed', repeat('a', 64),
    'activate', (select v from t_ids where k = 'txn_1'),
    'cs_proof_1', 'pi_proof_1', 4900, 'usd');

  if v_result <> 'duplicate' then
    raise exception 'PROOF C/E FAILED: expected duplicate, got %', v_result;
  end if;
  if (select count(*) from public.payment_events where provider_event_id = 'evt_B') <> 1 then
    raise exception 'PROOF C/E FAILED: a duplicate event row was created';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_1')) <> 1 then
    raise exception 'PROOF C/E FAILED: a second unlock was created';
  end if;
end $$;

-- A DIFFERENT event id for the SAME payment: recorded independently, and the
-- unlock is reused rather than duplicated. The partial unique index on
-- `production_unlocks` is the independent second fence behind the event id.
do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_B2', 'checkout.session.async_payment_succeeded', repeat('b', 64),
    'activate', (select v from t_ids where k = 'txn_1'),
    'cs_proof_1', 'pi_proof_1', 4900, 'usd');

  if v_result <> 'processed' then
    raise exception 'PROOF C2 FAILED: expected processed, got %', v_result;
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_1')) <> 1 then
    raise exception 'PROOF C2 FAILED: a second distinct event duplicated the unlock';
  end if;
  if (select count(*) from public.payment_events) <> 2 then
    raise exception 'PROOF C2 FAILED: both events should be recorded independently';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (D) A mismatch inside the operation leaves the transaction UNMODIFIED, makes
--     no unlock, and records an honest failure rather than claiming success.
-- ---------------------------------------------------------------------------

do $$
declare
  v_result text;
  v_before text;
begin
  v_before := (select status from public.payment_transactions
               where id = (select v from t_ids where k = 'txn_2'));

  -- Wrong checkout session.
  v_result := public.apply_payment_event(
    'stripe', 'evt_D1', 'checkout.session.completed', repeat('c', 64),
    'activate', (select v from t_ids where k = 'txn_2'),
    'cs_WRONG', 'pi_proof_2', 4900, 'usd');
  if v_result <> 'rejected_mismatch' then
    raise exception 'PROOF D FAILED: session mismatch returned %', v_result;
  end if;

  -- Wrong amount.
  v_result := public.apply_payment_event(
    'stripe', 'evt_D2', 'checkout.session.completed', repeat('d', 64),
    'activate', (select v from t_ids where k = 'txn_2'),
    'cs_proof_2', 'pi_proof_2', 4899, 'usd');
  if v_result <> 'rejected_mismatch' then
    raise exception 'PROOF D FAILED: amount mismatch returned %', v_result;
  end if;

  -- Wrong currency.
  v_result := public.apply_payment_event(
    'stripe', 'evt_D3', 'checkout.session.completed', repeat('e', 64),
    'activate', (select v from t_ids where k = 'txn_2'),
    'cs_proof_2', 'pi_proof_2', 4900, 'eur');
  if v_result <> 'rejected_mismatch' then
    raise exception 'PROOF D FAILED: currency mismatch returned %', v_result;
  end if;

  -- Unknown transaction — provider metadata never bootstraps a purchase.
  v_result := public.apply_payment_event(
    'stripe', 'evt_D4', 'checkout.session.completed', repeat('f', 64),
    'activate', '00000000-0000-4000-8000-000000000000',
    'cs_proof_2', 'pi_proof_2', 4900, 'usd');
  if v_result <> 'unmatched' then
    raise exception 'PROOF D FAILED: unknown transaction returned %', v_result;
  end if;

  -- Nothing moved.
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_2')) <> v_before then
    raise exception 'PROOF D FAILED: a refused event modified the transaction';
  end if;
  if (select provider_payment_intent_id from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_2')) is not null then
    raise exception 'PROOF D FAILED: a refused event bound a payment intent';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_2')) <> 0 then
    raise exception 'PROOF D FAILED: a refused event created an unlock';
  end if;

  -- And the events say so honestly — never `processed`.
  if exists (
    select 1 from public.payment_events
    where provider_event_id in ('evt_D1', 'evt_D2', 'evt_D3', 'evt_D4')
      and outcome = 'processed'
  ) then
    raise exception 'PROOF D FAILED: a refused event was recorded as processed';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (F) One provider payment intent can never pay off two transactions.
-- ---------------------------------------------------------------------------

do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_F', 'checkout.session.completed', repeat('9', 64),
    'activate', (select v from t_ids where k = 'txn_2'),
    'cs_proof_2', 'pi_proof_1', 4900, 'usd');   -- txn_1's intent

  if v_result <> 'rejected_mismatch' then
    raise exception 'PROOF F FAILED: a reused payment intent returned %', v_result;
  end if;
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_2')) = 'paid' then
    raise exception 'PROOF F FAILED: a reused payment intent paid a second transaction';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_2')) <> 0 then
    raise exception 'PROOF F FAILED: a reused payment intent created an unlock';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Out-of-order: an expiry must never downgrade a paid transaction.
-- ---------------------------------------------------------------------------

do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_EXP', 'checkout.session.expired', repeat('7', 64),
    'expire', (select v from t_ids where k = 'txn_1'),
    'cs_proof_1', null, null, null);

  if v_result <> 'ignored' then
    raise exception 'PROOF OOO FAILED: expiring a paid transaction returned %', v_result;
  end if;
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_1')) <> 'paid' then
    raise exception 'PROOF OOO FAILED: a paid transaction was downgraded';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_1')
        and status = 'active') <> 1 then
    raise exception 'PROOF OOO FAILED: the unlock was disturbed by an expiry';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (J) ROLLBACK IS GENUINELY TRANSACTIONAL.
-- ---------------------------------------------------------------------------
--
-- The claim that matters most, and the one code inspection cannot make: the
-- three writes are ONE unit. If the function committed anything on its own
-- (an autonomous transaction, dblink, a subtransaction that escaped), rolling
-- back to a savepoint afterwards would leave residue behind.
--
-- A successful call is made and then discarded. Every trace of it must vanish
-- — the event, the paid status, and the unlock alike.

savepoint before_atomic_unit;

do $$
declare v_result text;
begin
  v_result := public.apply_payment_event(
    'stripe', 'evt_J', 'checkout.session.completed', repeat('8', 64),
    'activate', (select v from t_ids where k = 'txn_2'),
    'cs_proof_2', 'pi_proof_J', 4900, 'usd');
  if v_result <> 'processed' then
    raise exception 'PROOF J SETUP FAILED: expected processed, got %', v_result;
  end if;
  -- All three halves are visible inside the transaction...
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_2')) <> 'paid' then
    raise exception 'PROOF J SETUP FAILED: transaction not paid';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_2')
        and status = 'active') <> 1 then
    raise exception 'PROOF J SETUP FAILED: unlock not created';
  end if;
end $$;

rollback to savepoint before_atomic_unit;

do $$
begin
  -- ...and NONE of them survive the rollback.
  if exists (select 1 from public.payment_events where provider_event_id = 'evt_J') then
    raise exception 'PROOF J FAILED: the event row committed independently of its transaction';
  end if;
  if (select status from public.payment_transactions
      where id = (select v from t_ids where k = 'txn_2')) = 'paid' then
    raise exception 'PROOF J FAILED: the paid status committed independently';
  end if;
  if (select count(*) from public.production_unlocks
      where project_id = (select v from t_ids where k = 'project_2')) <> 0 then
    raise exception 'PROOF J FAILED: the unlock committed independently';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (G) RLS enabled, zero policies, browser grants revoked.
-- ---------------------------------------------------------------------------

do $$
declare
  rls_on boolean;
  policy_count int;
  leaked text;
begin
  select c.relrowsecurity into rls_on
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'payment_events';
  if not coalesce(rls_on, false) then
    raise exception 'PROOF G FAILED: RLS is not enabled on payment_events';
  end if;

  select count(*) into policy_count
  from pg_policies where schemaname = 'public' and tablename = 'payment_events';
  if policy_count <> 0 then
    raise exception 'PROOF G FAILED: payment_events has % policy/policies', policy_count;
  end if;

  select string_agg(distinct grantee || ':' || privilege_type, ', ') into leaked
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'payment_events'
    and grantee in ('anon', 'authenticated');
  if leaked is not null then
    raise exception 'PROOF G FAILED: payment_events grants to browser roles: %', leaked;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (H) THE FUNCTION IS NOT CALLABLE BY anon / authenticated.
-- ---------------------------------------------------------------------------
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default. Through
-- PostgREST that default would make the payment-activation authority callable
-- by an anonymous browser. The migration revokes it; this proves the revoke
-- actually took effect rather than trusting that it was written.

do $$
declare
  offending text;
begin
  select string_agg(role_name, ', ') into offending
  from unnest(array['anon', 'authenticated', 'public']) as role_name
  where has_function_privilege(
    role_name,
    'public.apply_payment_event(text, text, text, text, text, uuid, text, text, integer, text)',
    'EXECUTE');

  if offending is not null then
    raise exception 'PROOF H FAILED: apply_payment_event is EXECUTABLE by: %', offending;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- (I) service_role — which the server actually runs as — CAN execute it.
-- ---------------------------------------------------------------------------

do $$
begin
  if not has_function_privilege(
    'service_role',
    'public.apply_payment_event(text, text, text, text, text, uuid, text, text, integer, text)',
    'EXECUTE') then
    raise exception 'PROOF I FAILED: service_role cannot execute apply_payment_event';
  end if;
end $$;

-- SECURITY INVOKER, not DEFINER — asserted rather than assumed. `prosecdef`
-- true would mean the function runs with its owner's privileges, a standing
-- escalation path through code that moves money.
do $$
begin
  if (select p.prosecdef
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'apply_payment_event') then
    raise exception 'PROOF I FAILED: apply_payment_event is SECURITY DEFINER';
  end if;
end $$;

-- The search_path is pinned, so the function cannot be redirected to shadowed
-- tables by a caller-controlled path.
do $$
declare cfg text[];
begin
  select p.proconfig into cfg
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'apply_payment_event';

  if cfg is null or not (cfg && array['search_path=public, pg_temp']) then
    raise exception 'PROOF I FAILED: apply_payment_event has no pinned search_path (got %)', cfg;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- No permissive browser-facing policy anywhere.
-- ---------------------------------------------------------------------------

do $$
declare offending text;
begin
  select string_agg(schemaname || '.' || tablename || '.' || policyname, ', ')
    into offending
  from pg_policies
  where schemaname = 'public'
    and (roles::text[] && array['anon', 'authenticated', 'public']);
  if offending is not null then
    raise exception 'PROOF FAILED: browser-facing policy/policies exist: %', offending;
  end if;
end $$;

rollback;

\echo 'ALL A5.4 PAYMENT EVENT + ATOMICITY POSTGRES PROOFS PASSED'
