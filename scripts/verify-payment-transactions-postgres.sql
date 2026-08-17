-- Sprint A5.3 — REAL POSTGRESQL PROOF for `public.payment_transactions`.
--
-- Run against a throwaway database with the complete migration history
-- applied. Every check is a claim about what the DATABASE refuses, not about
-- what application code remembers to check. Each assertion raises if the
-- invariant does not hold, so a passing run means every one executed.
--
-- Nothing here touches production. No customer data is read. No provider is
-- contacted — this file proves schema, not payment.
--
--   docker run -d --name ihp-a5-proof -e POSTGRES_PASSWORD=proof postgres:16
--   docker exec ihp-a5-proof psql -U postgres -c \
--     "create role anon nologin; create role authenticated nologin; \
--      create role service_role nologin bypassrls;"
--   docker exec ihp-a5-proof createdb -U postgres ihp_proof
--   docker exec ihp-a5-proof psql -U postgres -d ihp_proof -c "
--     create schema storage;
--     create table storage.buckets (id text primary key, name text, public boolean);
--     grant usage on schema public to anon, authenticated, service_role;
--     alter default privileges in schema public grant all on tables to service_role;"
--   -- apply supabase/migrations/*.sql in filename order, then this file.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

create temporary table t_ids (k text primary key, v uuid);

with s as (
  insert into public.acquisition_sessions (session_token)
  values ('a53-proof-session') returning id
)
insert into t_ids select 'session', id from s;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5.3 proof project 1', 'intake', (select v from t_ids where k = 'session'))
  returning id
)
insert into t_ids select 'project_1', id from p;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('a5.3 proof project 2', 'intake', (select v from t_ids where k = 'session'))
  returning id
)
insert into t_ids select 'project_2', id from p;

-- ---------------------------------------------------------------------------
-- 1. The table exists with the expected shape.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.payment_transactions') is null then
    raise exception 'PROOF 1 FAILED: public.payment_transactions does not exist';
  end if;
end $$;

do $$
declare
  missing text;
begin
  select string_agg(expected, ', ') into missing
  from unnest(array[
    'id', 'project_id', 'acquisition_session_id', 'production_profile',
    'provider', 'provider_checkout_session_id', 'provider_checkout_url',
    'provider_payment_intent_id', 'amount_minor', 'currency', 'status',
    'created_at', 'updated_at'
  ]) as expected
  where not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_transactions'
      and column_name = expected
  );
  if missing is not null then
    raise exception 'PROOF 1b FAILED: missing column(s): %', missing;
  end if;
end $$;

-- The buyer binding cannot be absent. This is also WHY a legacy project
-- (acquisition_session_id IS NULL) cannot check out: there would be no buyer
-- to record, and fabricating one would invent an identity never captured.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payment_transactions'
      and column_name in ('project_id', 'acquisition_session_id',
                          'production_profile', 'provider', 'amount_minor',
                          'currency', 'status')
      and is_nullable = 'YES'
  ) then
    raise exception 'PROOF 1c FAILED: an authority-bearing column is nullable';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS enabled, ZERO policies.
-- ---------------------------------------------------------------------------
--
-- The most sensitive table in the schema: amounts, buyer bindings, and live
-- provider checkout URLs.

do $$
declare
  rls_on boolean;
  policy_count int;
begin
  select c.relrowsecurity into rls_on
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'payment_transactions';

  if not coalesce(rls_on, false) then
    raise exception 'PROOF 2 FAILED: RLS is not enabled on payment_transactions';
  end if;

  select count(*) into policy_count
  from pg_policies
  where schemaname = 'public' and tablename = 'payment_transactions';

  if policy_count <> 0 then
    raise exception 'PROOF 2b FAILED: payment_transactions has % policy/policies; it must have zero', policy_count;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. anon / authenticated hold NO privileges; service_role still works.
-- ---------------------------------------------------------------------------

do $$
declare
  leaked text;
begin
  select string_agg(distinct grantee || ':' || privilege_type, ', ') into leaked
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'payment_transactions'
    and grantee in ('anon', 'authenticated');
  if leaked is not null then
    raise exception 'PROOF 3 FAILED: payment_transactions grants to browser roles: %', leaked;
  end if;
end $$;

do $$
begin
  if not has_table_privilege('service_role', 'public.payment_transactions', 'INSERT') then
    raise exception 'PROOF 3b FAILED: service_role cannot write payment_transactions';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. THE OUTSTANDING-ATTEMPT INVARIANT.
-- ---------------------------------------------------------------------------

insert into public.payment_transactions
  (project_id, acquisition_session_id, production_profile, provider,
   amount_minor, currency, status)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'session'),
   'apparel_raster', 'stripe', 4900, 'usd', 'pending_provider');

-- A second outstanding attempt for the same project+profile is refused, even
-- in the OTHER outstanding status. Two tabs must converge on one payment
-- page, and only a constraint can guarantee that under concurrency.
do $$
begin
  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status, provider_checkout_session_id,
       provider_checkout_url)
    values
      ((select v from t_ids where k = 'project_1'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'created',
       'cs_proof_second', 'https://checkout.example/second');
    raise exception 'PROOF 4 FAILED: a SECOND outstanding attempt was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 5. A terminal attempt frees the slot; history accumulates.
-- ---------------------------------------------------------------------------

update public.payment_transactions
set status = 'failed'
where project_id = (select v from t_ids where k = 'project_1');

insert into public.payment_transactions
  (project_id, acquisition_session_id, production_profile, provider,
   amount_minor, currency, status, provider_checkout_session_id,
   provider_checkout_url)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'session'),
   'apparel_raster', 'stripe', 4900, 'usd', 'created',
   'cs_proof_1', 'https://checkout.example/1');

do $$
declare
  total int; outstanding int;
begin
  select count(*),
         count(*) filter (where status in ('pending_provider', 'created'))
    into total, outstanding
  from public.payment_transactions
  where project_id = (select v from t_ids where k = 'project_1');

  if total <> 2 then
    raise exception 'PROOF 5 FAILED: the failed attempt should survive alongside the new one (found % rows)', total;
  end if;
  if outstanding <> 1 then
    raise exception 'PROOF 5b FAILED: expected exactly one outstanding attempt, found %', outstanding;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Provider ids are UNIQUE, and nullable-many.
-- ---------------------------------------------------------------------------
--
-- One provider session belongs to exactly one attempt, so a webhook can never
-- resolve to two rows.

do $$
begin
  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status, provider_checkout_session_id,
       provider_checkout_url)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'created',
       'cs_proof_1', 'https://checkout.example/dupe');
    raise exception 'PROOF 6 FAILED: a duplicate provider_checkout_session_id was accepted';
  exception when unique_violation then null;
  end;
end $$;

update public.payment_transactions
set provider_payment_intent_id = 'pi_proof_1'
where provider_checkout_session_id = 'cs_proof_1';

do $$
begin
  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status, provider_checkout_session_id,
       provider_checkout_url, provider_payment_intent_id)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'created',
       'cs_proof_2', 'https://checkout.example/2', 'pi_proof_1');
    raise exception 'PROOF 6b FAILED: a duplicate provider_payment_intent_id was accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Many unbound rows coexist: UNIQUE permits many NULLs, which is what lets
-- several projects hold pre-provider attempts at once.
insert into public.payment_transactions
  (project_id, acquisition_session_id, production_profile, provider,
   amount_minor, currency, status)
values
  ((select v from t_ids where k = 'project_2'),
   (select v from t_ids where k = 'session'),
   'apparel_raster', 'stripe', 4900, 'usd', 'pending_provider');

-- ---------------------------------------------------------------------------
-- 7. Vocabulary CHECKs — profile, provider, status.
-- ---------------------------------------------------------------------------

do $$
declare bad text;
begin
  foreach bad in array array[
    'apparel_vector', 'out_of_scope_product', 'signage', 'logo_vector',
    'unknown', ''
  ] loop
    begin
      insert into public.payment_transactions
        (project_id, acquisition_session_id, production_profile, provider,
         amount_minor, currency, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session'),
         bad, 'stripe', 4900, 'usd', 'pending_provider');
      raise exception 'PROOF 7 FAILED: production_profile "%" was accepted', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

do $$
declare bad text;
begin
  foreach bad in array array['paypal', 'Stripe', 'none', ''] loop
    begin
      insert into public.payment_transactions
        (project_id, acquisition_session_id, production_profile, provider,
         amount_minor, currency, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session'),
         'apparel_raster', bad, 4900, 'usd', 'pending_provider');
      raise exception 'PROOF 7b FAILED: provider "%" was accepted', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

do $$
declare bad text;
begin
  foreach bad in array array['succeeded', 'complete', 'PAID', 'open', ''] loop
    begin
      insert into public.payment_transactions
        (project_id, acquisition_session_id, production_profile, provider,
         amount_minor, currency, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session'),
         'apparel_raster', 'stripe', 4900, 'usd', bad);
      raise exception 'PROOF 7c FAILED: status "%" was accepted', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Amount must be positive; currency must be a lowercase ISO 4217 shape.
-- ---------------------------------------------------------------------------

do $$
declare bad int;
begin
  foreach bad in array array[0, -1, -4900] loop
    begin
      insert into public.payment_transactions
        (project_id, acquisition_session_id, production_profile, provider,
         amount_minor, currency, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session'),
         'apparel_raster', 'stripe', bad, 'usd', 'pending_provider');
      raise exception 'PROOF 8 FAILED: amount_minor % was accepted', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

do $$
declare bad text;
begin
  foreach bad in array array['USD', 'us', 'usdd', 'u5d', '$', ''] loop
    begin
      insert into public.payment_transactions
        (project_id, acquisition_session_id, production_profile, provider,
         amount_minor, currency, status)
      values
        ((select v from t_ids where k = 'project_2'),
         (select v from t_ids where k = 'session'),
         'apparel_raster', 'stripe', 4900, bad, 'pending_provider');
      raise exception 'PROOF 8b FAILED: currency "%" was accepted', bad;
    exception when check_violation then null;
    end;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 9. `created` must be bound; `pending_provider` must NOT be.
-- ---------------------------------------------------------------------------
--
-- Without these two, a partial write could leave a row claiming a checkout
-- exists with nowhere to send the customer — or a "pre-provider" row already
-- holding a session, which makes the two states indistinguishable afterwards.

do $$
begin
  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'created');
    raise exception 'PROOF 9 FAILED: a created attempt with no session/url was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status, provider_checkout_session_id,
       provider_checkout_url)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'created', 'cs_only', null);
    raise exception 'PROOF 9b FAILED: a created attempt with no url was accepted';
  exception when check_violation then null;
  end;

  begin
    insert into public.payment_transactions
      (project_id, acquisition_session_id, production_profile, provider,
       amount_minor, currency, status, provider_checkout_session_id,
       provider_checkout_url)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'session'),
       'apparel_raster', 'stripe', 4900, 'usd', 'pending_provider',
       'cs_premature', 'https://checkout.example/premature');
    raise exception 'PROOF 9c FAILED: a pending_provider attempt holding a session was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 10. ON DELETE RESTRICT on both foreign keys.
-- ---------------------------------------------------------------------------
--
-- Financial history is precisely the thing a cascade must not silently take
-- with it.

do $$
begin
  begin
    delete from public.print_projects
    where id = (select v from t_ids where k = 'project_2');
    raise exception 'PROOF 10 FAILED: a project with a payment transaction was deletable';
  exception when foreign_key_violation then null;
  end;

  begin
    delete from public.acquisition_sessions
    where id = (select v from t_ids where k = 'session');
    raise exception 'PROOF 10b FAILED: a session with a payment transaction was deletable';
  exception when foreign_key_violation then null;
  end;
end $$;

do $$
declare wrong text;
begin
  select string_agg(con.conname || '=' || con.confdeltype::text, ', ') into wrong
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace n on n.oid = rel.relnamespace
  where n.nspname = 'public' and rel.relname = 'payment_transactions'
    and con.contype = 'f' and con.confdeltype::text <> 'r';
  if wrong is not null then
    raise exception 'PROOF 10c FAILED: foreign key(s) not ON DELETE RESTRICT: %', wrong;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 11. A5.3 CREATES NO ENTITLEMENT.
-- ---------------------------------------------------------------------------
--
-- The whole slice in one assertion: attempts exist, and not one production
-- unlock does. Nothing in this schema can turn a transaction into an
-- entitlement — there is no foreign key, no trigger, and no shared column.

do $$
declare
  attempts int; unlocks int;
begin
  select count(*) into attempts from public.payment_transactions;
  select count(*) into unlocks from public.production_unlocks;

  if attempts = 0 then
    raise exception 'PROOF 11 FAILED: the fixture created no payment transactions, so this proves nothing';
  end if;
  if unlocks <> 0 then
    raise exception 'PROOF 11 FAILED: % production unlock(s) exist; checkout must never create one', unlocks;
  end if;
end $$;

-- And no schema-level path from one to the other.
do $$
declare linked text;
begin
  select string_agg(con.conname, ', ') into linked
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_class frel on frel.oid = con.confrelid
  where con.contype = 'f'
    and ((rel.relname = 'payment_transactions' and frel.relname = 'production_unlocks')
      or (rel.relname = 'production_unlocks' and frel.relname = 'payment_transactions'));
  if linked is not null then
    raise exception 'PROOF 11b FAILED: a foreign key links payments to entitlements: %', linked;
  end if;
end $$;

do $$
declare trigs text;
begin
  select string_agg(tgname, ', ') into trigs
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relname in ('payment_transactions', 'production_unlocks')
    and not t.tgisinternal;
  if trigs is not null then
    raise exception 'PROOF 11c FAILED: unexpected trigger(s) on the commerce tables: %', trigs;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 12. No permissive browser-facing policy anywhere.
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
    raise exception 'PROOF 12 FAILED: browser-facing policy/policies exist: %', offending;
  end if;
end $$;

rollback;

\echo 'ALL A5.3 PAYMENT TRANSACTION POSTGRES PROOFS PASSED'
