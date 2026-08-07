# Final Artwork Worker — Deployment Guide

Sprint 2M Phase 2C. Companion to the architecture doc comments in
`src/capabilities/final-artwork-worker/` and ARCHITECTURE.md §13c. Sibling
document to `docs/deployment/generation-worker.md` — read that first if
you haven't; this doc only calls out what differs.

## Why a second worker

`FinalArtworkJob` is a distinct queue from `GenerationJob`: different
trigger (explicit "Prepare Print-Ready Artwork" approval, not brief
approval), different output (a production asset + an authoritative
`PrintValidationReport`, never a concept). It gets its own table, its own
claim methods, its own worker capability, and its own protected endpoint —
never folded into the generation worker's process or endpoint, so the two
queues can be observed, scaled, and restarted independently.

The customer-visible contract is three honest states: **Preparing your
print-ready artwork…**, **Your print-ready artwork is ready**, and **We
need to review your artwork before it can be finalized**. Everything below
is invisible infrastructure behind that contract.

## Architecture

```
FinalArtworkJob ("queued")
        ↓
Independent Worker Scheduler   (capabilities/worker-scheduler — FinalArtworkSchedulerCapability)
        ↓
Atomic Job Claim               (ProjectRepository.claimNextQueuedFinalArtworkJob)
        ↓
Final Artwork Worker           (capabilities/final-artwork-worker)
        ↓
Source Eligibility Gate         (Sprint 2M Phase 2E — skip paid reconstruction
        ↓                        on an already-known-invalid source)
Raster Transformation/          (capabilities/final-artwork — FinalArtworkProvider:
Reconstruction                   LocalRasterInterpolationProvider or, since
        ↓                        Sprint 2M Phase 2E, TopazTransparencyUpscaleProvider)
        ↓
Production Asset Upload         (capabilities/assets — uploadProductionAsset)
        ↓
Authoritative Print Validation   (capabilities/print-validation — unchanged capability, new caller)
        ↓
Print-Ready Transition           (PrintProject.status)
```

## The three supported topologies

Same shape as the generation worker — only what calls
`finalArtworkScheduler.runBatch()` / `.start()` changes.

### 1. Scheduled endpoint (recommended for production)

```bash
curl -sf -X POST "https://<app>/api/worker/final-artwork" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -o /dev/null
```

Local raster transformation is CPU-bound and fast (no network call) —
unlike concept generation, there is no provider latency to wait out. A
cadence of roughly once a minute is more than sufficient; this queue is
expected to be low-volume (one job per customer's "Prepare Print-Ready
Artwork" click).

### 2. Standalone worker process

```bash
npm run worker:final-artwork
```

Runs `scripts/run-final-artwork-worker.ts` — no HTTP layer, just
`finalArtworkScheduler.start()` on a timer inside its own process. Stops
cleanly on `SIGINT`/`SIGTERM`.

```yaml
# Future app spec addition — not required for this sprint.
workers:
  - name: final-artwork-worker
    run_command: npm run worker:final-artwork
    instance_count: 1
```

### 3. Inside the web process

Same note as the generation worker's doc: topology (1) running against the
web process's own container is not a separate code path.

## Local development

```bash
npm run worker:final-artwork
```

in a second terminal, or hit the endpoint by hand:

```bash
curl -X POST http://localhost:3000/api/worker/final-artwork \
  -H "X-Worker-Secret: iheartprints-local-dev-worker-secret-do-not-use-in-production"
```

## Configuration

No new environment variables. `WORKER_SECRET`, `MAX_GENERATION_JOBS_PER_RUN`,
and `WORKER_HEARTBEAT_INTERVAL` are shared with the generation worker (see
`docs/deployment/generation-worker.md`'s table) — one shared secret, one
shared batch-size knob, one shared heartbeat cadence, since both are
equally "how the independent worker layer behaves" rather than something
specific to either job type.

## Atomic claim

`ProjectRepository.claimNextQueuedFinalArtworkJob()` mirrors
`claimNextQueuedJob()` exactly: a single conditional update (Supabase) or
the local store's mutex-serialized equivalent (every `LocalProjectRepository`
method is already wrapped in a proxy-enforced mutex — see
`local-store.ts`'s doc comment). Two workers racing for the same job always
resolve to exactly one winner.

## Recovery & retries

- A "running" job whose heartbeat goes stale (default: 15 minutes) becomes
  "recoverable" and gets reclaimed on the next scheduler run.
- A shared retry budget (`MAX_FINAL_ARTWORK_ATTEMPTS`, currently 3) caps
  attempts across worker-recovery reclaims.
- Recovery never duplicates a production asset: a job that already
  produced its production PNG (`AssetRecord.finalArtworkJobId` +
  `productionRole === "production_png"`) short-circuits straight to
  (re)validation on a reclaimed attempt.
- A `"failed"` job (infrastructure problem — storage/transformation
  failure) is revived back to `"queued"` the next time the customer's
  existing "Prepare Print-Ready Artwork" action runs
  (`FinalArtworkCapability.requestFinalArtwork`) — no separate retry
  endpoint, no PowerShell required.
- A `"completed"` job that honestly landed on `finalization_required` is
  never auto-retried — that is a real verdict about the artwork itself,
  not a hiccup worth re-running.

## Print-ready transition safety

Only `FinalArtworkWorkerCapability`, after a real `PrintValidationCapability.validateArtwork`
call against a real production asset, may set `PrintProject.status =
"print_ready"`. It also refuses to transition status for a stale/recovered
job whose approval is no longer the project's current active one — a job
recovered long after the customer moved on (regenerated, approved a
different direction) can never stomp a newer direction's status.

## Live provider safety

Sprint 2M Phase 2E integrated the first real, paid provider — Topaz
Transparency Upscale — behind `FinalArtworkProvider`. See ARCHITECTURE.md
§13d for the full design. Deployment-relevant summary:

- `FINAL_ARTWORK_PROVIDER=local` (default, safe everywhere) —
  `LocalRasterInterpolationProvider`, no network call, no paid request.
- `FINAL_ARTWORK_PROVIDER=topaz` + `TOPAZ_API_KEY` — real Topaz
  reconstruction. Latency is provider-bound: the Sprint 2M Phase 2D
  bake-off observed ~70–130s per call; the worker's existing periodic
  heartbeat (`WORKER_HEARTBEAT_INTERVAL`) keeps a long-running job from
  looking abandoned to the stale-job recovery sweep.
- `FINAL_ARTWORK_PROVIDER=topaz` without `TOPAZ_API_KEY` fails the job
  safely (`UnavailableFinalArtworkProvider`) — never a silent fallback to
  local interpolation, never `print_ready`.
- Paid-call idempotency (`FinalArtworkJob.providerKey`/`providerRequestId`/
  `providerStatus`) means a crash mid-poll resumes the same paid request on
  retry rather than submitting a second one — see §13d "Paid-call
  idempotency". This is why nothing in this worker's normal operation
  (scheduled endpoint, standalone process, or a customer's read-only status
  poll) should ever be expected to spend more than one Topaz credit per
  `FinalArtworkJob` under normal conditions.
- `TOPAZ_API_KEY` is server-only: never logged, never returned from an API
  route, never included in a customer snapshot. `providerRequestId` is
  internal-only diagnostics, same rule.
