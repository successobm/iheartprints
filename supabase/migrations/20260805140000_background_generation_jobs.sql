-- Sprint 2H Part 2A: background generation jobs + real Supabase Storage
-- backend. Additive only. Does not edit or rename any previously applied
-- migration.

-- A "running" job whose worker went silent is recoverable, not failed —
-- nothing about generation itself failed.
alter type public.generation_job_status add value if not exists 'recoverable';

-- Which customer-facing flow a job belongs to. Lets the worker choose the
-- right completion/failure message and post-success side effect purely
-- from the job row, without staying coupled to whoever enqueued it.
alter table public.generation_jobs
  add column if not exists kind text not null default 'initial' check (kind in ('initial', 'regeneration')),
  add column if not exists started_at timestamptz null,
  add column if not exists completed_at timestamptz null,
  -- Bumped periodically while a worker actively runs this job. Recovery
  -- sweeps use this, not updated_at, so an incidental status/attempts
  -- write never resets the abandonment clock.
  add column if not exists heartbeat_at timestamptz null;

-- The default above only exists to satisfy the not-null constraint for any
-- historical row; new inserts always specify kind explicitly.
alter table public.generation_jobs alter column kind drop default;

create index generation_jobs_status_created_at_idx
  on public.generation_jobs (status, created_at)
  where status in ('queued', 'recoverable');

create index generation_jobs_running_heartbeat_idx
  on public.generation_jobs (heartbeat_at)
  where status = 'running';

-- Private bucket for generated artwork bytes. The application talks to it
-- exclusively through the service-role key (server-side only), so no
-- public/anon storage.objects policy is required for this bucket — the
-- deny-by-default RLS Supabase Storage ships with already blocks anon/auth
-- access; this INSERT just registers the bucket itself.
--
-- Service-role clients intentionally bypass storage.objects RLS. That is
-- the only intended access path: server-side upload / createSignedUrl /
-- delete. Customer browsers never talk to this bucket directly — they
-- receive short-lived signed URLs only. Force `public = false` even if a
-- prior manual insert left the row public (`do nothing` would not fix that).
insert into storage.buckets (id, name, public)
values ('design-assets', 'design-assets', false)
on conflict (id) do update set public = excluded.public;
