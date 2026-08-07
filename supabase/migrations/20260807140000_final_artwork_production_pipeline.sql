-- Sprint 2M Phase 2C: First Real Production Artwork Pipeline (Raster Apparel).
-- Additive only. Does not edit or rename any previously applied migration.
--
-- NOTE: 'finalization_required' is added to the `project_status` enum here.
-- It is not referenced by any index, constraint, or DML in this same file —
-- per the lesson from 20260805140000/20260806182103 (SQLSTATE 55P04), a
-- freshly-added enum value cannot be used within the same transaction that
-- added it. `final_artwork_jobs.status` is a plain `text` CHECK column, not
-- a native enum, so its own new 'recoverable' value has no such restriction
-- and its claim-queue index is safe to add in this same file.

-- A `FinalArtworkJob` ran to completion (a real production asset was
-- created) but authoritative Print Validation did not return "ready".
-- Distinct from 'finalizing' (still in progress) and 'failed' (the
-- pipeline itself errored) — see `src/lib/domain/types.ts`.
alter type public.project_status add value if not exists 'finalization_required';

-- `FinalArtworkWorkerCapability`'s own worker lifecycle — mirrors
-- `generation_jobs`' claim/heartbeat/recovery columns exactly.
alter table public.final_artwork_jobs
  add column if not exists attempts integer not null default 0,
  add column if not exists started_at timestamptz null,
  add column if not exists completed_at timestamptz null,
  add column if not exists heartbeat_at timestamptz null;

alter table public.final_artwork_jobs
  drop constraint if exists final_artwork_jobs_status_check;

alter table public.final_artwork_jobs
  add constraint final_artwork_jobs_status_check
  check (status in ('queued', 'running', 'recoverable', 'completed', 'failed', 'cancelled'));

create index if not exists final_artwork_jobs_status_created_at_idx
  on public.final_artwork_jobs (status, created_at)
  where status in ('queued', 'recoverable');

create index if not exists final_artwork_jobs_running_heartbeat_idx
  on public.final_artwork_jobs (heartbeat_at)
  where status = 'running';

-- Sprint 2M Phase 2C (Goal 10): explicit production-deliverable
-- classification. The `final_artwork_job_id` foreign key alone cannot
-- distinguish a future PNG from an SVG from a PDF once one job owns more
-- than one production asset. Always null for concept-stage assets.
alter table public.assets
  add column if not exists production_role text null
  check (production_role in ('production_png', 'production_svg', 'production_pdf'));

create index if not exists assets_final_artwork_job_id_production_role_idx
  on public.assets (final_artwork_job_id, production_role)
  where final_artwork_job_id is not null;

-- Sprint 2M Phase 2C (Goal 12): authoritative Print Validation's persisted
-- home. Its own append-only table — never a single status column on
-- `artwork_versions` (audited and rejected in Phase 2A/2B) — because one
-- `final_artwork_job` may eventually own more than one production asset,
-- each with independent readiness. A revalidation inserts a new row rather
-- than overwriting the last one, so validation history stays auditable
-- (Constitution §6.11).
create table public.production_asset_validations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  final_artwork_job_id uuid not null references public.final_artwork_jobs (id) on delete cascade,
  asset_id uuid not null references public.assets (id) on delete cascade,
  status text not null check (status in ('ready', 'finalization_required', 'blocked')),
  -- Full internal PrintValidationReport (check reasons, requirements,
  -- required transformations) — print-shop/internal diagnostics only,
  -- never surfaced to the customer as-is (Goal 13).
  report jsonb not null default '{}'::jsonb,
  validated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index production_asset_validations_project_id_idx
  on public.production_asset_validations (project_id);

create index production_asset_validations_job_id_created_at_idx
  on public.production_asset_validations (final_artwork_job_id, created_at desc);
