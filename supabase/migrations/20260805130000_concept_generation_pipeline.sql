-- Sprint 2H Part 1: real, provider-neutral concept generation infrastructure
-- (generation jobs, assets, concept provenance). Additive only. Does not
-- edit or rename any previously applied migration.

create type public.generation_job_status as enum (
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled'
);

-- Customer-never-sees-this lifecycle for a single generation attempt.
-- Deterministic (project_id, idempotency_key) identity means a retried
-- request never creates a duplicate job or duplicate concepts.
create table public.generation_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  design_brief_version_id uuid not null references public.design_brief_versions (id) on delete cascade,
  status public.generation_job_status not null default 'queued',
  concept_count integer not null,
  -- Internal provenance only — never surfaced to the customer.
  provider_key text not null,
  idempotency_key text not null,
  attempts integer not null default 0,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, idempotency_key)
);

create index generation_jobs_project_id_idx on public.generation_jobs (project_id);

-- A generated or uploaded file and its metadata. Storage stays abstracted
-- behind storage_key (an opaque reference — a data URI today, a real
-- object-store key/URL in a future sprint) so swapping storage backends
-- never touches downstream tables.
create table public.assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  kind text not null,
  storage_key text null,
  content_type text null,
  is_thumbnail boolean not null default false,
  width_px integer null,
  height_px integer null,
  has_transparency boolean null,
  -- Internal provenance only — never surfaced to the customer.
  provider_key text null,
  generation_job_id uuid null references public.generation_jobs (id) on delete set null,
  -- Sanitized provider response envelope. Must never contain prompt text or credentials.
  metadata jsonb not null default '{}'::jsonb,
  -- Reserved for a future vector (SVG) companion asset.
  vector_asset_id uuid null,
  -- Reserved for a future print-ready production asset.
  print_asset_id uuid null,
  created_at timestamptz not null default now()
);

create index assets_project_id_idx on public.assets (project_id);

alter table public.assets
  add constraint assets_vector_asset_id_fkey
  foreign key (vector_asset_id) references public.assets (id) on delete set null,
  add constraint assets_print_asset_id_fkey
  foreign key (print_asset_id) references public.assets (id) on delete set null;

-- Concept model additions. All nullable/defaulted so existing rows and the
-- placeholder provider path (which never sets them) remain valid without
-- backfill.
alter table public.artwork_versions
  add column if not exists generation_job_id uuid null references public.generation_jobs (id) on delete set null,
  add column if not exists primary_asset_id uuid null references public.assets (id) on delete set null,
  add column if not exists thumbnail_asset_id uuid null references public.assets (id) on delete set null,
  -- Internal provenance only — never surfaced to the customer.
  add column if not exists provider_key text null,
  -- Reserved for a future customer rating feature.
  add column if not exists customer_rating integer null,
  -- Reserved for future automated concept evaluation.
  add column if not exists evaluation_status text null,
  -- Reserved for future print validation.
  add column if not exists print_validation_status text null;
