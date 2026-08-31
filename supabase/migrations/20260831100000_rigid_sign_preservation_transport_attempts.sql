-- Signs Phase S4.2C.1: durable, RECOVERABLE bookkeeping for one in-flight
-- OpenAI Files-transport semantic-preservation attempt.
--
-- NOT APPLIED TO PRODUCTION IN THIS PHASE — designed and reviewed, staged
-- for a future explicit "commit and integrate" phase like every other
-- migration in this repository's history.
--
-- WHAT THIS IS, AND IS NOT:
--
--   This is transient TRANSPORT-LIFECYCLE state — "which of the 14
--   deterministic comparison images have I already uploaded to OpenAI
--   Files, under what file id, and have I cleaned them up yet?" — never
--   permanent semantic evidence (that remains
--   `rigid_sign_preservation_verifications.semantic_evidence`,
--   20260831090000). Overloading that table's JSON with transient
--   in-flight bookkeeping was explicitly rejected (Signs Phase S4.2C.1
--   §14): the two have different lifecycles (this row is expected to be
--   updated repeatedly across an attempt and eventually redacted; a
--   verification row is append-only and immutable once written) and
--   different retention needs (this row's `files[].provider_file_id`
--   values should be nulled out once cleanup succeeds; a verification's
--   evidence is permanent).
--
-- WHY MUTABLE (unlike `rigid_sign_preservation_verifications`'s
-- append-only discipline): this row's entire purpose is CRASH RECOVERY —
-- resuming after a crash mid-upload, recognizing all 14 uploads already
-- completed before ever calling the model, and recovering cleanup after a
-- crash post-inference. An append-only history of every intermediate
-- upload state would defeat that purpose (recovery needs the CURRENT
-- state, not a log of how it got there) and would accumulate unbounded
-- rows for a bounded, transient process.
--
-- IDENTITY: bound to the exact semantic verification identity it is
-- transporting for — `(final_asset_id, combined_verification_algorithm_
-- version)` — mirroring `rigid_sign_preservation_verifications`'s own
-- idempotency key one layer earlier in the pipeline. A transport attempt
-- can never be mistaken for a different verification identity's in-flight
-- work; bumping the combined identity (provider/model/prompt/schema/
-- image-derivation/transport version) always starts a fresh attempt row,
-- never silently reuses stale file ids from an incompatible prior attempt.

create table if not exists public.rigid_sign_preservation_transport_attempts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.print_projects (id) on delete cascade,

  final_asset_id uuid not null references public.assets (id) on delete cascade,
  source_asset_id uuid not null references public.assets (id) on delete restrict,
  intermediate_asset_id uuid not null references public.assets (id) on delete restrict,
  plan_key text not null,

  -- THE identity this attempt is transporting images FOR — matches
  -- `rigid_sign_preservation_verifications.verification_algorithm_version`
  -- exactly when that verification eventually completes.
  combined_verification_algorithm_version text not null,

  -- Explicit staleness lever for TRANSPORT MECHANISM behavior alone —
  -- independent of every other component already folded into the combined
  -- identity above. See `SIGN_PRESERVATION_TRANSPORT_VERSION_FILE_ID` in
  -- `src/capabilities/sign-preservation/contracts.ts`.
  transport_version text not null,

  status text not null check (
    status in (
      'in_progress',
      'uploads_complete',
      'inference_dispatched_ambiguous',
      'inference_completed',
      'cleanup_complete'
    )
  ),

  -- Per-image upload/cleanup bookkeeping. Exactly
  -- SIGN_PRESERVATION_MAX_IMAGE_COUNT (14) entries once uploads are
  -- underway. Each entry: { role, contentHash, providerFileId,
  -- uploadCompletedAt, cleanupCompletedAt } — NEVER image bytes/base64.
  -- `providerFileId` is redacted (set back to null) once that file's
  -- cleanup succeeds — see the header comment on retention.
  files jsonb not null default '[]'::jsonb,

  inference_dispatched_at timestamptz null,
  inference_outcome text null check (
    inference_outcome is null
    or inference_outcome in ('dispatched_ambiguous', 'completed', 'failed_pre_dispatch')
  ),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Idempotent identity: at most one transport attempt row per exact
-- (final_asset_id, combined_verification_algorithm_version) pair — the
-- same discipline `rigid_sign_preservation_verifications_identity_idx`
-- already established one layer down.
create unique index if not exists rigid_sign_preservation_transport_attempts_identity_idx
  on public.rigid_sign_preservation_transport_attempts (final_asset_id, combined_verification_algorithm_version);

-- Server-only lockdown, in the same migration that creates the table —
-- the convention 20260811191500 established and
-- `security-lockdown.migration.test.ts` enforces.
alter table public.rigid_sign_preservation_transport_attempts enable row level security;
revoke all privileges on table public.rigid_sign_preservation_transport_attempts from anon, authenticated;
