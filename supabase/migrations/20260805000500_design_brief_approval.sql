-- Sprint 2D: Design Summary approval gate.
-- Additive only. Does not edit or rename any previously applied migration.

-- New conversation phases for the approval gate. Existing values are untouched;
-- legacy phases (e.g. 'skip_references') remain valid for historical rows.
alter type public.conversation_phase add value if not exists 'awaiting_summary_confirmation';
alter type public.conversation_phase add value if not exists 'brief_approved';
alter type public.conversation_phase add value if not exists 'edit_requested';
alter type public.conversation_phase add value if not exists 'continue_requested';

-- Durable, append-only approval record. Each row is an immutable snapshot of the
-- working brief content at the moment the customer approved it. This is the
-- smallest step toward the future design_brief_versions/immutable-version model:
-- for now every row has status = 'approved'; 'draft' / 'superseded' are reserved
-- for a later sprint that snapshots intermediate drafts too.
create table public.design_brief_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  brief_id uuid not null references public.tshirt_design_briefs (id) on delete cascade,
  version_number integer not null,
  status text not null default 'approved' check (status in ('draft', 'approved', 'superseded')),
  content jsonb not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_id, version_number)
);

create index design_brief_versions_project_id_idx
  on public.design_brief_versions (project_id);

-- Concepts must reference the approved brief version that authorized them.
alter table public.artwork_versions
  add column design_brief_version_id uuid null references public.design_brief_versions (id) on delete set null;

create index artwork_versions_design_brief_version_id_idx
  on public.artwork_versions (design_brief_version_id);
