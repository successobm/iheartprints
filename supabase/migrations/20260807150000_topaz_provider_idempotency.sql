-- Sprint 2M Phase 2E: Topaz production reconstruction — paid-call idempotency.
-- Additive only. Does not edit or rename any previously applied migration.
--
-- A worker crash/race between submitting a paid reconstruction request
-- (e.g. Topaz Transparency Upscale) and persisting the resulting production
-- asset must never cause a second paid request on retry/recovery. These
-- columns durably record which provider is/was handling a given
-- FinalArtworkJob's reconstruction and that provider's own request
-- identity, so a resumed attempt can poll/download an existing in-flight
-- request instead of submitting a new one. See `FinalArtworkJob`'s doc in
-- `src/lib/domain/types.ts` and `FinalArtworkWorkerCapability`. Internal
-- only — never exposed to a customer-facing surface.

alter table public.final_artwork_jobs
  add column if not exists provider_key text null,
  add column if not exists provider_request_id text null,
  add column if not exists provider_status text null;
