-- DTF-R1 (Cursor Blocker 2) — bind the job's outstanding provider request
-- to the SOURCE it was submitted for. Additive only. Does not edit or
-- rename any previously applied migration.
--
-- WHY A COLUMN WAS UNAVOIDABLE HERE.
--
-- A FinalArtworkJob holds exactly one outstanding provider request
-- (provider_key / provider_request_id / provider_status). Resuming it is
-- what makes a crashed or bounded-pending reconstruction recoverable
-- without paying twice, so the resume path is deliberately trusting.
--
-- Before DTF-R1 that was safe: a prepared-upload job's source could not
-- move underneath it. DTF-R1 makes the effective source resolvable at
-- worker time (prepared asset -> Production-Qualified Clean Master, or one
-- master superseding another), so a job can now revive, correctly resolve a
-- NEW source, and still resume a provider request submitted for the OLD
-- one. The provider returns the old source's pixels; the pipeline records
-- the new source's asset id, SHA-256 and sourceAuthority. Pixels from A
-- with provenance claiming B is false lineage, and Print Ready being
-- withheld later does not make it true.
--
-- The two reconstruction-stage ARTIFACT classes carry their source identity
-- in asset metadata already (provider-result intermediates always did;
-- pass-1 intermediates now do too, in the same change, with no migration).
-- That closes every window in which a durable artifact exists. It cannot
-- close the first one: between submission and the first durable download
-- there is no artifact to carry the identity, and the only row that exists
-- is the job itself. Inferring the source after the fact is not possible,
-- and retiring an unprovable slot instead would resubmit — and therefore
-- re-bill — on every poll of a perfectly healthy in-flight request.
--
-- So the binding lives next to the slot it describes.
--
-- BACKWARD COMPATIBLE BY CONSTRUCTION. Both columns are nullable with no
-- default. A row written before this migration has NULL, which the worker
-- reads as "no claim either way" and resumes exactly as it does today —
-- never as a mismatch, because treating legacy rows as stale would abandon
-- real, already-paid-for requests that are in flight at deploy time. Every
-- submission from now on writes the binding, so the tolerance closes itself
-- as those jobs drain.
--
-- The values are only ever read while provider_request_id is non-null; a
-- leftover binding beside a cleared slot is inert, which is why the many
-- slot-clearing sites do not need to clear these too.

alter table public.final_artwork_jobs
  add column if not exists provider_source_asset_id text;

alter table public.final_artwork_jobs
  add column if not exists provider_source_sha256 text;
