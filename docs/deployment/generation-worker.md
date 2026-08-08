# Background Generation Worker — Deployment Guide

Sprint 2H Part 2B. Companion to the architecture doc comments in
`src/capabilities/generation-worker/` and `src/capabilities/worker-scheduler/`.

## Why this exists

Concept generation must never depend on a customer's browser staying open,
on the customer refreshing, on another HTTP request happening to arrive, or
on an in-process "fire and forget" task tied to some other request's
lifecycle. This doc describes how to run the independent worker that makes
that true in a real deployment.

The customer-visible contract stays exactly two states: **Generating
Concepts...** then **Concepts Ready**. Everything below is invisible
infrastructure behind that contract.

## Architecture

```
Queued Generation Job
        ↓
Independent Worker Scheduler   (capabilities/worker-scheduler)
        ↓
Atomic Job Claim               (ProjectRepository.claimNextQueuedJob)
        ↓
Generation                     (capabilities/generation-worker — unchanged)
        ↓
Asset Upload                   (capabilities/assets)
        ↓
Concept Creation                (ProjectRepository.addArtworkVersions)
        ↓
Conversation Update             (assistant message + status)
```

`GenerationWorkerCapability` (business logic: claim → generate → upload →
persist → message) never changed shape in this sprint and never talks to
HTTP, a scheduler, or a secret. `GenerationSchedulerCapability` is a thin
layer on top that decides *when* and *how many times* to call it —
recover, then claim in a bounded loop, then stop. Nothing about either one
is aware of which of the three topologies below it's running under.

## The three supported topologies

The same code runs unmodified in all three — only what calls
`workerScheduler.runBatch()` / `.start()` changes.

### 1. Scheduled endpoint (recommended HTTP topology for production today)

`POST /api/worker/generation`, protected by `WORKER_SECRET`, calls
`workerScheduler.runBatch()` once per request.

**Production (`NODE_ENV=production`):** the route **awaits** `runBatch()` and
returns `{ ok: true }` only after that batch finishes (including real
image-generation duration). Do **not** treat a fast HTTP `200` as
acceptable here — a detached Promise after the response is **not**
production-safe on DigitalOcean/Next request lifecycles.

**Interactive local (`next dev`, not an automated test):** the route may
return quickly after starting or joining a batch without awaiting
provider-duration work, so manual curls are not blocked for minutes. Job
rows / project status remain the source of truth for completion. This is
developer convenience only.

**Automated tests (`IHEARTPRINTS_AUTOMATED_TEST=1`):** always await the
batch, even when `NODE_ENV` is not `production`. Detaching during
`npm test` left local-store writes running past teardown and, with
parallel test files sharing `process.chdir`, caused Windows `EBUSY`
rmdir failures in unrelated suites.

Point a scheduler at the production endpoint:

**DigitalOcean App Platform — Scheduled Job:**

```yaml
jobs:
  - name: generation-worker-tick
    kind: PRE_DEPLOY # not this — see note below
```

DigitalOcean App Platform's native "Scheduled Job" component type runs a
command on a cron schedule inside its own container, not an HTTP call — for
this endpoint-based topology, use a DigitalOcean **Function** (or any
external cron: GitHub Actions scheduled workflow, `cron` on a small VM,
Uptime-monitoring-style pingers) configured to:

```bash
# Production: await the full batch — allow several minutes for OpenAI image gen.
curl -sf --max-time 600 -X POST "https://<app>/api/worker/generation" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -o /dev/null
```

Cron/trigger **HTTP timeouts must accommodate real image-generation
duration** (often multi-minute per job; up to `MAX_GENERATION_JOBS_PER_RUN`
jobs per tick). A one-minute cadence is still reasonable for *how often*
to tick an empty-or-busy queue; each tick's client timeout must be long
enough for a full batch, not 10 seconds.

### 2. Standalone worker process (future / preferred long-running topology)

`npm run worker` runs `scripts/run-generation-worker.ts` — no HTTP layer,
no web framework, just the scheduler's `start()` on a timer inside its own
process. This remains the **preferred long-running** shape for a future
DigitalOcean **Worker** component: a second component in the same App
Platform app spec, same repo/build, different start command
(`npm run worker` instead of `npm start`), running continuously alongside
the web service so generation is not bound to an HTTP request lifetime. It
stops cleanly on `SIGINT`/`SIGTERM` (App Platform sends `SIGTERM` on
redeploy/scale-down).

```yaml
# Future app spec addition — not required for this sprint.
workers:
  - name: generation-worker
    run_command: npm run worker
    instance_count: 1 # see "Concurrency" below before raising this
```

### 3. Inside the web process

Both topologies above execute inside the same Next.js server process the
web app already runs — "inside the web process" was never a separate code
path, it's just topology (1) with the scheduler's caller being an external
cron instead of a dedicated worker component). There is deliberately no
always-on in-process timer wired into the web server itself in this
sprint — that would reintroduce exactly the shape being removed
(generation coupled to the web process's own lifecycle rather than an
explicit, observable schedule).

## Local development

Interactive `next dev` auto-triggers the in-process scheduler after
Approve / Create Concepts (or regenerate) enqueues a job. No second
terminal and no manual PowerShell/`curl` is required for that path.
Production never uses this trigger; automated tests
(`IHEARTPRINTS_AUTOMATED_TEST=1`) never use it either.

Optional alternatives still work:

- Run `npm run worker` in a second terminal alongside `npm run dev`. It
  uses the same `WORKER_SECRET`-free dev fallback as everything else in
  this codebase outside production.
- Or hit the endpoint by hand whenever you want a queued job to run:

  ```bash
  curl -X POST http://localhost:3000/api/worker/generation \
    -H "X-Worker-Secret: iheartprints-local-dev-worker-secret-do-not-use-in-production"
  ```

In `next dev`, that POST may return `{ ok: true }` quickly while generation
continues in-process — poll project/generation status (or the job row) for
completion. Do not copy that fast-return behavior into production cron or
into automated tests.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_SECRET` | *(unset)* | Shared secret for the worker endpoint. **Required in production** — the endpoint fails closed (401) without it there. Outside production, an unset value falls back to a well-known dev secret so local dev needs no setup. |
| `MAX_GENERATION_JOBS_PER_RUN` | `5` | Jobs processed per scheduler run before stopping, even if more are queued. |
| `WORKER_HEARTBEAT_INTERVAL` | `15000` (ms) | How often an actively-running job's heartbeat is touched, and the standalone process's default wake interval. |

All three are read fresh by `src/lib/config/worker-config.ts` — no
restart-order dependency, no secret ever logged.

## Atomic claim (cross-instance concurrency authority)

`ProjectRepository.claimNextQueuedJob()` is a single conditional
update (`UPDATE ... WHERE id = ? AND status = ?`, or the local store's
in-process mutex-serialized equivalent) — two workers racing for the same
job always resolve to exactly one winner. `recoverAbandonedJobs()` was
hardened the same way this sprint (single atomic conditional update, no
select-then-blind-write gap) so a job that heartbeats or completes in the
same window a recovery sweep is evaluating it can never be double-claimed.
See `src/capabilities/generation-worker/generation-worker-concurrency.test.ts`
and `src/lib/db/supabase-store.generation-jobs.test.ts` for the tests that
pin this down for both repositories.

`GenerationSchedulerCapability.hasActiveBatch()` is **only** a
process-local dedupe/observability flag (overlapping `runBatch()` calls in
one Node process join the same in-flight Promise). It is **not** a
distributed lock and is **not** required for claim correctness — another
app instance has its own flag and still races safely at the database
claim/recovery layer.

## Recovery & retries

- A "running" job whose heartbeat goes stale (default: 15 minutes with no
  touch) becomes "recoverable" and gets reclaimed on the next scheduler
  run — see `DEFAULT_STALE_JOB_MS`.
- A shared retry budget (`MAX_GENERATION_ATTEMPTS`, currently 3) caps
  attempts however they're spread across customer-initiated retries and
  worker-recovery reclaims. A job that keeps getting its worker killed
  before finishing eventually fails permanently with a customer-facing
  message instead of looping forever — see
  `capabilities/shared/generation-retry-policy.ts`.
- Recovery never duplicates a concept: a job that actually completed just
  before a stale sweep reclaims it short-circuits as already-done (see
  `runClaimedJob`'s idempotent `alreadyGenerated` check).

## Polling stays read-only in production

`GET /api/projects/[projectId]/generation/status` never claims work, never
revives a failed/running job, and never calls a provider. Automated tests
keep that contract (`IHEARTPRINTS_AUTOMATED_TEST=1`).

Interactive `next dev` only: if the project is `generating` and a job is
still `queued` with `attempts=0` (missed post-enqueue kick or stale HMR),
status poll / project reload may kick `workerScheduler.runBatch()`
in-process. That does not change FIFO claim order and is not used in
production.

## Future work (not built in this sprint)

- **Container worker**: package the standalone process (topology 2) as its
  own container image sharing the app's build, deployed as a DigitalOcean
  App Platform Worker component or a small dedicated droplet/Kubernetes
  deployment — no code change required, only deployment config.
- **Real queue**: if job volume outgrows polling-based claim (SQS,
  DigitalOcean-hosted Redis + a queue library, a Postgres `LISTEN/NOTIFY`
  wake-up instead of a fixed poll interval), `GenerationSchedulerCapability`
  is the only layer that would need to change — `GenerationWorkerCapability`
  and every repository's claim contract stay the same.
