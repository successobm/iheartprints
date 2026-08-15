-- Sprint A4 Correction 1 — REAL POSTGRESQL PROOF.
--
-- Run against a throwaway database with the complete migration history
-- applied (see the runner in the sprint report). Every check below is a
-- claim about what the DATABASE refuses, not about what application code
-- remembers to check — which is the entire point of the correction. Each
-- one raises an exception if the invariant does not hold, so a passing run
-- means every assertion actually executed.
--
-- Nothing here touches production. No customer data is read.

\set ON_ERROR_STOP on

begin;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------

create temporary table t_ids (k text primary key, v uuid);

with s as (
  insert into public.acquisition_sessions (session_token) values ('proof-session-a')
  returning id
)
insert into t_ids select 'session_a', id from s;

with s as (
  insert into public.acquisition_sessions (session_token) values ('proof-session-b')
  returning id
)
insert into t_ids select 'session_b', id from s;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('proof project 1', 'intake', (select v from t_ids where k = 'session_a'))
  returning id
)
insert into t_ids select 'project_1', id from p;

with p as (
  insert into public.print_projects (name, status, acquisition_session_id)
  values ('proof project 2', 'intake', (select v from t_ids where k = 'session_a'))
  returning id
)
insert into t_ids select 'project_2', id from p;

with b as (
  insert into public.tshirt_design_briefs (project_id)
  values ((select v from t_ids where k = 'project_1'))
  returning id
)
insert into t_ids select 'brief_1', id from b;

with v as (
  insert into public.design_brief_versions (project_id, brief_id, version_number, content)
  values (
    (select v from t_ids where k = 'project_1'),
    (select v from t_ids where k = 'brief_1'),
    1,
    '{}'::jsonb
  )
  returning id
)
insert into t_ids select 'version_1', id from v;

-- ---------------------------------------------------------------------------
-- A. Two concurrent free-concept job creations → exactly one winner.
--
-- The P0-2 guarantee. Both inserts name the SAME session and DIFFERENT
-- idempotency keys, which is precisely the shape of "a second free concept"
-- (a second project, or a retry after a lost consumption marker). The
-- database must refuse the second regardless of what application code did.
-- ---------------------------------------------------------------------------

insert into public.generation_jobs
  (project_id, design_brief_version_id, concept_count, provider_key,
   idempotency_key, kind, acquisition_session_id)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'version_1'),
   1, 'proof', 'free-key-1', 'initial',
   (select v from t_ids where k = 'session_a'));

do $$
declare
  refused boolean := false;
begin
  begin
    insert into public.generation_jobs
      (project_id, design_brief_version_id, concept_count, provider_key,
       idempotency_key, kind, acquisition_session_id)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'version_1'),
       1, 'proof', 'free-key-2', 'initial',
       (select v from t_ids where k = 'session_a'));
  exception when unique_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'A FAILED: the database allowed a SECOND free-concept job for one session';
  end if;
  raise notice 'A PASS: second free-concept job refused by unique index';
end $$;

-- A second job for the SAME session in a DIFFERENT project is the strongest
-- form of the bypass and is covered above (project_2 was used deliberately).

-- ---------------------------------------------------------------------------
-- B. An ORDINARY job is completely unaffected — many per project, and many
--    with no acquisition session at all. The correction must not have made
--    normal generation single-shot.
-- ---------------------------------------------------------------------------

insert into public.generation_jobs
  (project_id, design_brief_version_id, concept_count, provider_key, idempotency_key, kind)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'version_1'), 3, 'proof', 'ordinary-1', 'initial'),
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'version_1'), 3, 'proof', 'ordinary-2', 'regeneration'),
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'version_1'), 1, 'proof', 'ordinary-3', 'regeneration');

do $$
declare
  n integer;
begin
  select count(*) into n from public.generation_jobs
   where acquisition_session_id is null;
  if n <> 3 then
    raise exception 'B FAILED: expected 3 ordinary jobs, found %', n;
  end if;
  raise notice 'B PASS: NULL acquisition_session_id repeats freely (% ordinary jobs)', n;
end $$;

-- A different session may of course have its own one free job.
insert into public.generation_jobs
  (project_id, design_brief_version_id, concept_count, provider_key,
   idempotency_key, kind, acquisition_session_id)
values
  ((select v from t_ids where k = 'project_1'),
   (select v from t_ids where k = 'version_1'),
   1, 'proof', 'free-key-session-b', 'initial',
   (select v from t_ids where k = 'session_b'));

-- ---------------------------------------------------------------------------
-- C. Job created, consumption marker NEVER written → still no second job.
--
-- The exact P0-2 crash window. Note that no consumption marker has been
-- written for session_a at any point in this script, and section A already
-- proved a second job is impossible. This asserts the reconciliation READ
-- that the application relies on in that state.
-- ---------------------------------------------------------------------------

do $$
declare
  marker timestamptz;
  reconciled uuid;
begin
  select free_concept_consumed_at into marker
    from public.acquisition_sessions
   where id = (select v from t_ids where k = 'session_a');
  if marker is not null then
    raise exception 'C FAILED: fixture is wrong — marker should be unwritten';
  end if;

  select id into reconciled from public.generation_jobs
   where acquisition_session_id = (select v from t_ids where k = 'session_a');
  if reconciled is null then
    raise exception 'C FAILED: consumption is not reconcilable from the job';
  end if;
  raise notice 'C PASS: marker unwritten, yet consumption reconcilable from job %', reconciled;
end $$;

-- ---------------------------------------------------------------------------
-- D. Consumed authority survives deletion of the job it names (P1-3).
--
-- `free_concept_generation_job_id` must NOT be a foreign key any more, so
-- deleting the job leaves both it and `free_concept_consumed_at` intact.
-- ---------------------------------------------------------------------------

update public.acquisition_sessions
   set free_concept_generation_job_id =
         (select id from public.generation_jobs
           where acquisition_session_id = (select v from t_ids where k = 'session_a')),
       free_concept_consumed_at = now()
 where id = (select v from t_ids where k = 'session_a');

do $$
declare
  fk_count integer;
  job_id uuid;
  kept_job uuid;
  kept_marker timestamptz;
begin
  -- The FK must be gone. If it is still there with SET NULL, the delete
  -- below would silently erase the authority instead of failing this check.
  select count(*) into fk_count
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'acquisition_sessions'
     and con.contype = 'f'
     and con.conkey = array(
       select attnum from pg_attribute
        where attrelid = rel.oid and attname = 'free_concept_generation_job_id'
     );
  if fk_count <> 0 then
    raise exception 'D FAILED: free_concept_generation_job_id still has a foreign key';
  end if;

  select free_concept_generation_job_id into job_id
    from public.acquisition_sessions
   where id = (select v from t_ids where k = 'session_a');

  delete from public.generation_jobs where id = job_id;

  select free_concept_generation_job_id, free_concept_consumed_at
    into kept_job, kept_marker
    from public.acquisition_sessions
   where id = (select v from t_ids where k = 'session_a');

  if kept_marker is null then
    raise exception 'D FAILED: deleting the job erased free_concept_consumed_at';
  end if;
  if kept_job is distinct from job_id then
    raise exception 'D FAILED: deleting the job erased the historical job reference';
  end if;
  raise notice 'D PASS: consumed authority survived deletion of job %', job_id;
end $$;

-- ---------------------------------------------------------------------------
-- D2. THE CORRECTION 2 CASE: delete the free job, then try to insert another
--     free job for the same session. Must be REJECTED.
--
-- This is the test that was missing. Section A proves the unique index on
-- `generation_jobs.acquisition_session_id` refuses a second job — but that
-- index only constrains rows that EXIST, and section D just deleted the row.
-- Without the session-owned claim, the slot is now free and a direct insert
-- succeeds, handing the session a second free image.
--
-- The claim (`acquisition_free_concept_claims`, PRIMARY KEY on the session)
-- is not a child of the job and was not touched by that DELETE, so the
-- BEFORE INSERT trigger still raises `unique_violation`.
-- ---------------------------------------------------------------------------

do $$
declare
  claim_survived uuid;
  orphaned_job uuid;
  refused boolean := false;
begin
  -- The job is gone (section D deleted it) and the claim is not.
  select acquisition_session_id, generation_job_id
    into claim_survived, orphaned_job
    from public.acquisition_free_concept_claims
   where acquisition_session_id = (select v from t_ids where k = 'session_a');

  if claim_survived is null then
    raise exception 'D2 FAILED: the free-concept claim did not survive job deletion';
  end if;
  if exists (select 1 from public.generation_jobs where id = orphaned_job) then
    raise exception 'D2 FAILED: fixture is wrong — the job was not actually deleted';
  end if;

  begin
    insert into public.generation_jobs
      (project_id, design_brief_version_id, concept_count, provider_key,
       idempotency_key, kind, acquisition_session_id)
    values
      ((select v from t_ids where k = 'project_1'),
       (select v from t_ids where k = 'version_1'),
       1, 'proof', 'free-key-after-delete', 'initial',
       (select v from t_ids where k = 'session_a'));
  exception when unique_violation then
    refused := true;
  end;

  if not refused then
    raise exception
      'D2 FAILED: deleting the free job allowed a SECOND free-concept job for the same session';
  end if;
  raise notice
    'D2 PASS: claim outlived job % and refused a second free job after deletion', orphaned_job;
end $$;

-- The claim also refuses a second free job in a DIFFERENT project — the
-- strongest form of the bypass, after deletion.
do $$
declare
  refused boolean := false;
begin
  begin
    insert into public.generation_jobs
      (project_id, design_brief_version_id, concept_count, provider_key,
       idempotency_key, kind, acquisition_session_id)
    values
      ((select v from t_ids where k = 'project_2'),
       (select v from t_ids where k = 'version_1'),
       1, 'proof', 'free-key-other-project-after-delete', 'initial',
       (select v from t_ids where k = 'session_a'));
  exception when unique_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'D2 FAILED: a second project reused the deleted session''s free attempt';
  end if;
  raise notice 'D2 PASS: second project also refused after deletion';
end $$;

-- ---------------------------------------------------------------------------
-- D3. An ORDINARY job is never claimed, and is freely repeatable — the
--     trigger must be inert for every job that is not an acquisition job.
-- ---------------------------------------------------------------------------

do $$
declare
  claims integer;
begin
  insert into public.generation_jobs
    (project_id, design_brief_version_id, concept_count, provider_key,
     idempotency_key, kind)
  values
    ((select v from t_ids where k = 'project_1'),
     (select v from t_ids where k = 'version_1'), 3, 'proof', 'ordinary-4', 'initial'),
    ((select v from t_ids where k = 'project_1'),
     (select v from t_ids where k = 'version_1'), 1, 'proof', 'ordinary-5', 'regeneration');

  select count(*) into claims from public.acquisition_free_concept_claims;
  -- Only the two genuinely free attempts (session_a, session_b) ever claimed.
  if claims <> 2 then
    raise exception 'D3 FAILED: expected exactly 2 claims, found %', claims;
  end if;
  raise notice 'D3 PASS: ordinary jobs take no claim (% total claims)', claims;
end $$;

-- ---------------------------------------------------------------------------
-- E. Deleting an acquisition session cannot convert its projects to legacy
--    (P1-4). ON DELETE RESTRICT must refuse the delete outright.
-- ---------------------------------------------------------------------------

do $$
declare
  refused boolean := false;
  still_bound uuid;
begin
  begin
    delete from public.acquisition_sessions
     where id = (select v from t_ids where k = 'session_a');
  exception when foreign_key_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'E FAILED: an acquisition session with bound projects was deletable';
  end if;

  select acquisition_session_id into still_bound
    from public.print_projects
   where id = (select v from t_ids where k = 'project_1');
  if still_bound is null then
    raise exception 'E FAILED: project was converted to legacy (NULL authority)';
  end if;
  raise notice 'E PASS: session delete refused; project still bound to %', still_bound;
end $$;

-- The allocation side is protected the same way: deleting the allocated
-- project must not clear the session's allocation.
update public.acquisition_sessions
   set free_concept_project_id = (select v from t_ids where k = 'project_1')
 where id = (select v from t_ids where k = 'session_b');

do $$
declare
  refused boolean := false;
begin
  begin
    delete from public.print_projects
     where id = (select v from t_ids where k = 'project_1');
  exception when foreign_key_violation then
    refused := true;
  end;
  if not refused then
    raise exception 'E FAILED: deleting the allocated project cleared the allocation';
  end if;
  raise notice 'E PASS: allocated project delete refused';
end $$;

-- ---------------------------------------------------------------------------
-- F. A legacy project (NULL authority) is still representable — the
--    grandfathering case must not have been broken by the RESTRICT rule.
-- ---------------------------------------------------------------------------

do $$
declare
  legacy_id uuid;
begin
  insert into public.print_projects (name, status)
  values ('legacy proof project', 'intake')
  returning id into legacy_id;

  if (select acquisition_session_id from public.print_projects where id = legacy_id)
     is not null then
    raise exception 'F FAILED: a project with no session did not read as NULL';
  end if;
  raise notice 'F PASS: legacy NULL authority still representable';
end $$;

-- ---------------------------------------------------------------------------
-- G. Server-only lockdown still holds for both A4 tables.
-- ---------------------------------------------------------------------------

do $$
declare
  bad text;
begin
  select string_agg(c.relname, ', ') into bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'acquisition_sessions',
       'generation_jobs',
       'acquisition_free_concept_claims'
     )
     and c.relrowsecurity = false;
  if bad is not null then
    raise exception 'G FAILED: RLS disabled on %', bad;
  end if;

  select string_agg(distinct table_name, ', ') into bad
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('acquisition_sessions', 'generation_jobs', 'acquisition_free_concept_claims')
     and grantee in ('anon', 'authenticated');
  if bad is not null then
    raise exception 'G FAILED: anon/authenticated hold privileges on %', bad;
  end if;

  select string_agg(tablename, ', ') into bad
    from pg_policies
   where schemaname = 'public'
     and tablename in ('acquisition_sessions', 'generation_jobs', 'acquisition_free_concept_claims');
  if bad is not null then
    raise exception 'G FAILED: unexpected RLS policy on %', bad;
  end if;
  raise notice 'G PASS: RLS enabled, zero policies, no anon/authenticated grants';
end $$;

rollback;
