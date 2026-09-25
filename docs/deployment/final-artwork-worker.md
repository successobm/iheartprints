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
Immediate Best-Effort Wake      (lib/services/final-artwork-http-wake — a LATENCY
        ↓                        OPTIMIZATION only, never authoritative — see
        ↓                        "Immediate wake vs. durable authority" below)
Independent Worker Scheduler   (capabilities/worker-scheduler — FinalArtworkSchedulerCapability)
        ↓
Atomic Job Claim               (ProjectRepository.claimNextQueuedFinalArtworkJob)
        ↓
Final Artwork Worker           (capabilities/final-artwork-worker)
        ↓
Source Eligibility Gate         (Sprint 2M Phase 2E — skip paid reconstruction
        ↓                        on an already-known-invalid source)
Bounded Raster Transformation/   (capabilities/final-artwork — FinalArtworkProvider:
Reconstruction                   LocalRasterInterpolationProvider — synchronous, one
        ↓                        invocation always finishes it — or, since Sprint 2M
        ↓                        Phase 2E, TopazTransparencyUpscaleProvider, which since
        ↓                        the Bounded FinalArtwork Production-Execution Repair
        ↓                        does at most ONE submit-or-status-check per invocation;
        ↓                        see "Bounded provider execution" below)
        ↓
Production Asset Upload         (capabilities/assets — uploadProductionAsset)
        ↓
Authoritative Print Validation   (capabilities/print-validation — unchanged capability, new caller)
        ↓
Print-Ready Transition           (PrintProject.status)
```

### Immediate wake vs. durable authority

The durable `FinalArtworkJob` row is the sole source of truth and the sole
correctness authority. The immediate wake (a real, authenticated,
best-effort HTTP POST to this SAME `/api/worker/final-artwork` route,
fired right after enqueue from both DTF creation paths — "Create New
Artwork" and "Upload Existing Artwork") exists ONLY to reduce how long a
customer waits for their job to *start*; it changes nothing about
whether it eventually finishes. Bounded, at 1.5s, by its own
`AbortController` — long enough to confirm the route accepted the
request, not long enough to observe a real batch's outcome (a genuine
Topaz submit+check routinely exceeds 1.5s, so an `AbortError` log line
on an otherwise perfectly healthy wake is expected and harmless, not a
failure signal). Aborting the CLIENT side of that fetch does not, and is
not intended to, cancel the SERVER-side `runBatch()` the route already
kicked off — that batch keeps running in the same process to whatever
conclusion it reaches regardless of whether anything is still listening
for its HTTP response. Every failure mode (network error, timeout,
non-2xx, missing `WORKER_SECRET`) is caught and logged, never thrown
back to the caller — the customer's enqueue request always succeeds or
fails purely on its own terms, never on the wake's. If the wake never
fires, is dropped, or the process it triggered dies mid-batch, the job
is exactly as durable as it always was: still `queued`/`recoverable`,
picked up by the next scheduler invocation (an immediate wake for a
DIFFERENT later job, or the recovery-insurance cron below).

## The three supported topologies

Same shape as the generation worker — only what calls
`finalArtworkScheduler.runBatch()` / `.start()` changes.

### 1. Scheduled endpoint (recovery insurance, and what production actually runs on a schedule)

```bash
curl -sf -X POST "https://<app>/api/worker/final-artwork" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -o /dev/null
```

Since the Bounded FinalArtwork Production-Execution Repair, PROMPT
starts are the immediate wake's job (see "Immediate wake vs. durable
authority" above) — the scheduled endpoint below is recovery insurance:
it exists so a job whose wake never fired, failed, or whose triggered
batch died mid-flight still eventually gets claimed and checked again,
with no customer/operator action required, ever. Its own cadence being
best-effort (see the live incident this repair was built for, below) is
tolerable specifically BECAUSE it is no longer the only thing standing
between "Create Print-Ready Artwork" and a job actually starting.

**Make Final Artwork Worker Run Automatically In Production Phase**: the
concrete scheduler is `.github/workflows/final-artwork-worker.yml` — a
GitHub Actions workflow, not a DigitalOcean-native component, chosen
because this app's DigitalOcean configuration has no in-repo `app.yaml`/
`.do/` spec (see "Runtime" above) and this environment had no
DigitalOcean API/console access to add a DO-native scheduled job
directly. It polls this SAME endpoint roughly once a minute (a `schedule`
trigger every 5 minutes — GitHub's own practical floor for that trigger
type — wrapping an in-job loop that calls the endpoint 4 times, 60s
apart, reproducing the "roughly once a minute" cadence above rather than
settling for a bare 5-minute cadence). Requires exactly one GitHub
Actions repository secret, `WORKER_SECRET`, set to the SAME value already
configured as this app's own `WORKER_SECRET` environment variable — never
a new/different value, never committed, read only via
`${{ secrets.WORKER_SECRET }}`. `workflow_dispatch` is available for a
manual, OPTIONAL debugging trigger only.

**GitHub's own scheduling is genuinely best-effort, by design, not a
misconfiguration to chase.** A real live incident (the one that motivated
this whole repair) observed this workflow's actual runs landing hours
apart — `3:23 PM`, `5:36 PM`, `10:19 PM`, `3:16 AM` — despite the
`*/5 * * * *` cron expression, because GitHub documents scheduled-workflow
triggers as best-effort and subject to delay during platform load. Do not
"fix" this by tightening the cron expression; the immediate wake exists
precisely because this layer cannot be made reliably prompt.

**The workflow FAILS the run (a visible red X, not just a warning) if any
of its four calls returns a non-200 status**, even though the other three
may have succeeded and durable jobs still progress — this was itself a
repair: an earlier version only failed when ALL FOUR calls failed, which
let a real HTTP 504 (the worker route blocking too long behind Topaz,
before this repair's bounded execution existed) hide inside an
otherwise-green run for a long time before anyone noticed the stuck job
behind it. A failed run does NOT cancel or block the next independently-
scheduled tick (`concurrency.cancel-in-progress: false`), so this is
pure visibility, never a correctness dependency.

Overlapping invocations are already safe by the worker's own
architecture (atomic per-job claim, §"Atomic claim" below) — this
workflow's `concurrency` group only avoids piling up redundant
GitHub-hosted runners, never a correctness dependency.

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
web process's own container is not a separate code path. Production must
not treat the web process as the authoritative final-artwork worker.

## Local development

Interactive `next dev` already mirrors generation: after a durable
`FinalArtworkJob` enqueue (Prepare Print-Ready),
`maybeTriggerLocalFinalArtworkWorker` kicks `finalArtworkScheduler.runBatch()`
in-process. A stranded `queued`/`attempts=0` job behind an active approval
is also recoverable from `GET .../finalization/status` or project reload
via `maybeRecoverStrandedLocalFinalArtworkJobs`. Production and automated
tests suppress both paths (`local-generation-trigger-policy.ts`).

You can still run a second terminal or hit the endpoint by hand when you
want the standalone-worker topology locally:

```bash
npm run worker:final-artwork
```

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
  "recoverable" and gets reclaimed on the next scheduler run — this is
  crash recovery: a worker process that DIED mid-attempt, never reaching
  any clean outcome.
- A shared retry budget (`MAX_FINAL_ARTWORK_ATTEMPTS`, currently 3) caps
  fresh-execution attempts, and a separate budget
  (`MAX_FINAL_ARTWORK_RECOVERY_ATTEMPTS`, currently 5) caps recovery
  attempts against an already-paid provider request — both exist to bound
  genuine crash/failure loops, never to bound ordinary bounded-pending
  polling (see "Bounded provider execution" below — a clean pending
  outcome refunds exactly what it charged, so it never counts against
  either budget; only a claim that actually crashed or genuinely erred
  keeps its charge).
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

## Bounded provider execution

Since the Bounded FinalArtwork Production-Execution Repair, no single
worker invocation may block waiting on a provider's async job — a real
live incident proved this was unsafe: the old design held one HTTP
request open through Topaz's full submit→poll→download cycle (up to
several minutes), behind a `curl --max-time 60` caller and an unverified
DigitalOcean gateway timeout, and a genuine job got cut off mid-poll,
orphaned with a real paid request nobody was checking on anymore.

`TopazTransparencyUpscaleProvider.produceBounded()` (preferred over the
older, still-present, still fully-blocking `produce()` whenever a
provider implements it) does AT MOST one of: submit a fresh request and
persist its identity, or check an existing request's status ONCE — never
`pollUntilDone`'s loop. Three outcomes per invocation:

- **Still pending** — the job returns to `"recoverable"` and the
  invocation returns quickly (well under any plausible gateway timeout).
  A LATER invocation (an immediate wake, or the next recovery-scheduler
  tick) checks again. `LocalRasterInterpolationProvider` has no
  asynchronous concept and has no `produceBounded` — the worker falls
  back to its unchanged, already-instant `produce()`, so this whole
  section is Topaz-specific.
- **Complete** — the worker continues through the SAME download →
  production-asset-upload → authoritative Print Validation path this
  document already describes, unchanged.
- **A real, non-transient failure** — the SAME fail-closed handling this
  document already describes (`"failed"`, provider identity cleared only
  on a provably-dead request).

**Liveness — one stuck job cannot starve newer ones.** A provider request
that stays pending for a long time is, by construction, always the
"oldest due" `queued`/`recoverable` row, and would otherwise keep
winning every claim in every batch forever. `claimNextQueuedFinalArtworkJob`
accepts an `excludeJobIds` list; the scheduler's batch loop adds a job's
id to that list the moment it sees a bounded-pending outcome for it
THIS batch, so the REST of that batch's claim slots go to other,
unrelated jobs instead of re-checking the same not-yet-finished request
repeatedly. This bounds starvation WITHIN one batch/invocation; it does
not (yet) bound how long a single provider request may legitimately stay
pending across MANY separate invocations/batches — see the open question
below.

**Open question, deliberately not answered by this repair:** what should
eventually happen to a Topaz request that never reaches `Completed`/
`Failed`/`Cancelled` at all (a genuinely hung/lost provider-side job,
distinct from ordinary 70–130s processing)? Today it remains
`"recoverable"` indefinitely, checked again on every later invocation,
with no automatic give-up. Picking a give-up threshold and the
resulting customer/operator-facing recovery behavior is a product/
operational policy decision, not an implementation defect with an
already-established answer — see the architecture-audit report for the
options this was weighed against before deliberately being left open.

## Production output contract

The deliverable is a trimmed, physical-size-aware PNG: the production artwork
itself defines the canvas. See ARCHITECTURE.md §13e for the full contract.
Deployment-relevant summary:

- Plates are sized by physical print WIDTH (10.5in for `full_front` /
  `full_back`, 4in `left_chest`, 3in `sleeve`) at 300 PPI, with height derived
  from the artwork's own aspect ratio. A full-front/full-back plate is 3150px
  wide; its height varies per design. There is no fixed 3600x4200 canvas.
- Each plate carries a `pHYs` density tag (11811 pixels per metre ≈ 300 PPI),
  so it opens at roughly its intended physical size in production software.
  That tag is a convenience for print shops only — readiness is always
  computed from pixels ÷ intended inches, never from the tag.
- Every production asset records its own normalization geometry (alpha
  bounding box, safety margin, occupancy, intended physical size) in its
  metadata. Authoritative validation recomputes from it; a retried or
  recovered attempt re-validates the same plate against the same evidence.
- A production asset created before this contract existed carries no such
  geometry. It is never deleted or rewritten, but if its job is ever re-run
  the worker honestly reports `finalization_required` rather than
  re-confirming print-readiness for an un-normalized plate. Re-preparing that
  project's artwork produces a correct plate (and, on `topaz`, spends one
  credit).

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
  bake-off observed ~70–130s per call. Since the Bounded FinalArtwork
  Production-Execution Repair, that latency is no longer absorbed by
  holding one worker invocation open (see "Bounded provider execution"
  above) — a normal job typically needs a small handful of short,
  separate invocations (an immediate wake, then one or two recovery
  checks) rather than one long-blocking one. The periodic heartbeat
  (`WORKER_HEARTBEAT_INTERVAL`) still exists and still matters for the
  crash-recovery sweep, but a bounded invocation is short enough that it
  rarely needs more than one heartbeat tick, if any.
- `FINAL_ARTWORK_PROVIDER=topaz` without `TOPAZ_API_KEY` fails the job
  safely (`UnavailableFinalArtworkProvider`) — never a silent fallback to
  local interpolation, never `print_ready`.
- Paid-call idempotency (`FinalArtworkJob.providerKey`/`providerRequestId`/
  `providerStatus`) means a crash — OR simply a later invocation finding
  the same request still in flight — resumes the same paid request rather
  than submitting a second one — see §13d "Paid-call idempotency" and
  "Bounded provider execution" above. This is why nothing in this
  worker's normal operation (immediate wake, scheduled endpoint,
  standalone process, or a customer's read-only status poll) should ever
  be expected to spend more than one Topaz credit per `FinalArtworkJob`
  under normal conditions.
- `TOPAZ_API_KEY` is server-only: never logged, never returned from an API
  route, never included in a customer snapshot. `providerRequestId` is
  internal-only diagnostics, same rule.
