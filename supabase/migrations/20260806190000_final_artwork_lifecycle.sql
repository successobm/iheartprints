-- Sprint 2M Phase 2B: Final Artwork Lifecycle & Production Approval Boundary.
-- Additive only. Does not edit or rename any previously applied migration.
--
-- No changes to `project_status` or `conversation_phase` are needed: both
-- 'finalizing' and 'print_ready' already exist on `project_status` (Sprint
-- 1's original enum) and were simply never assigned until this sprint.

-- Durable, append-only record of the customer's explicit "this is my final
-- direction — prepare it for production" decision. Distinct from concept
-- *selection* (`artwork_versions.is_selected` /
-- `print_projects.selected_artwork_version_id`), which only means "I want to
-- work with this direction" and may still be revised. At most one row per
-- project may be 'active' at a time — a new approval or a new concept batch
-- (regeneration) after this one supersedes it going forward; rows are never
-- deleted or rewritten (Constitution §6.11, Version Everything).
create table public.final_direction_approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  -- The exact, immutable concept this approval authorizes.
  artwork_version_id uuid not null references public.artwork_versions (id) on delete cascade,
  -- The approved Design Brief version this artwork was generated against.
  design_brief_version_id uuid not null references public.design_brief_versions (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'superseded')),
  approved_at timestamptz not null default now(),
  superseded_at timestamptz null,
  created_at timestamptz not null default now()
);

create index final_direction_approvals_project_id_idx
  on public.final_direction_approvals (project_id);

-- Enforces "at most one active approval per project" at the database level
-- — not just in application code — so a race between two concurrent
-- approval requests can never leave two rows simultaneously authoritative.
create unique index final_direction_approvals_active_per_project_idx
  on public.final_direction_approvals (project_id)
  where status = 'active';

-- Customer-never-sees-this lifecycle for a single production-finalization
-- attempt, keyed 1:1 to the approval that authorized it — this is what
-- makes a duplicate/double-click request naturally idempotent. Deliberately
-- its own table rather than a reuse of `generation_jobs`: different
-- trigger, different idempotency authority, different output (production
-- assets + an eventual authoritative Print Validation report, never concept
-- artwork). Phase 2B never claims or runs this job — every row starts and
-- stays 'queued' until a future phase adds a real worker.
create table public.final_artwork_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  final_direction_approval_id uuid not null references public.final_direction_approvals (id) on delete cascade,
  -- Denormalized for convenient querying — always the same artwork the approval references.
  artwork_version_id uuid not null references public.artwork_versions (id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, final_direction_approval_id)
);

create index final_artwork_jobs_project_id_idx
  on public.final_artwork_jobs (project_id);

-- Reserved: the production asset(s) a future FinalArtworkCapability
-- transformation produces for a given job. Always null until a later phase
-- executes real transformations. This — never a filename convention or
-- bucket-path parse — is the unambiguous way to tell a concept-stage asset
-- (generation_job_id is set) apart from a production deliverable
-- (final_artwork_job_id is set). One job may eventually own multiple
-- production assets (PNG + SVG + PDF), since this is a foreign key, not a
-- 1:1 slot.
alter table public.assets
  add column if not exists final_artwork_job_id uuid null references public.final_artwork_jobs (id) on delete set null;

create index if not exists assets_final_artwork_job_id_idx
  on public.assets (final_artwork_job_id)
  where final_artwork_job_id is not null;
