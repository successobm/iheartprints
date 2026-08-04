-- Sprint 1: conversational T-shirt design flow (no auth / orgs)

create extension if not exists "pgcrypto";

create type public.project_status as enum (
  'intake',
  'ready_to_generate',
  'generating',
  'concepts_ready',
  'revision_requested',
  'approved',
  'finalizing',
  'print_ready',
  'failed',
  'archived'
);

create type public.conversation_phase as enum (
  'ask_product',
  'ask_design',
  'ask_shirt_color',
  'ask_text',
  'skip_references',
  'generating',
  'concepts_ready',
  'ask_revisions',
  'revision_received'
);

create type public.message_role as enum ('user', 'assistant', 'system');

create type public.artwork_kind as enum ('concept', 'revision', 'final');

create table public.print_projects (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Untitled T-shirt design',
  status public.project_status not null default 'intake',
  selected_artwork_version_id uuid null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tshirt_design_briefs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.print_projects (id) on delete cascade,
  customer_name text null,
  project_name text null,
  product_summary text null,
  design_description text null,
  exact_text text null,
  shirt_color text null,
  print_placement text not null default 'full_front',
  intended_print_width_in numeric(6, 2) null,
  preferred_colors text[] not null default '{}',
  design_style text null,
  additional_instructions text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.design_conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.print_projects (id) on delete cascade,
  phase public.conversation_phase not null default 'ask_product',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.design_conversations (id) on delete cascade,
  project_id uuid not null references public.print_projects (id) on delete cascade,
  role public.message_role not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.artwork_versions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,
  version_number integer not null,
  kind public.artwork_kind not null default 'concept',
  title text not null,
  summary text not null,
  placeholder_label text not null,
  accent_color text not null,
  is_selected boolean not null default false,
  created_at timestamptz not null default now(),
  unique (project_id, version_number)
);

alter table public.print_projects
  add constraint print_projects_selected_artwork_version_id_fkey
  foreign key (selected_artwork_version_id)
  references public.artwork_versions (id)
  on delete set null;

create index conversation_messages_project_id_created_at_idx
  on public.conversation_messages (project_id, created_at);

create index artwork_versions_project_id_idx
  on public.artwork_versions (project_id);
