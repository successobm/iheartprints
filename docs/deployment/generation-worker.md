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

### 1. Scheduled endpoint (recommended for production)

`POST /api/worker/generation`, protected by `WORKER_SECRET`, calls
`workerScheduler.runBatch()` once per request and returns immediately.
Point a scheduler at it:

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
curl -sf -X POST "https://<app>/api/worker/generation" \
  -H "Authorization: Bearer $WORKER_SECRET" \
  -o /dev/null
```

Run it roughly as often as `WORKER_HEARTBEAT_INTERVAL` (default: every
15s–60s) — frequent enough that "Generating Concepts..." resolves quickly,
infrequent enough not to spend a scheduled invocation on an empty queue
constantly. A minute is a reasonable starting cadence for low volume.

### 2. Standalone worker process

`npm run worker` runs `scripts/run-generation-worker.ts` — no HTTP layer,
no web framework, just the scheduler's `start()` on a timer inside its own
process. This is the shape of a **future DigitalOcean "Worker" component**:
a second component in the same App Platform app spec, same repo/build,
different start command (`npm run worker` instead of `npm start`), running
continuously alongside the web service. It stops cleanly on `SIGINT`/
`SIGTERM` (App Platform sends `SIGTERM` on redeploy/scale-down).

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

Two options, either is fine:

- Run `npm run worker` in a second terminal alongside `npm run dev`. It
  uses the same `WORKER_SECRET`-free dev fallback as everything else in
  this codebase outside production.
- Or hit the endpoint by hand whenever you want a queued job to run:

  ```bash
  curl -X POST http://localhost:3000/api/worker/generation \
    -H "X-Worker-Secret: iheartprints-local-dev-worker-secret-do-not-use-in-production"
  ```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WORKER_SECRET` | *(unset)* | Shared secret for the worker endpoint. **Required in production** — the endpoint fails closed (401) without it there. Outside production, an unset value falls back to a well-known dev secret so local dev needs no setup. |
| `MAX_GENERATION_JOBS_PER_RUN` | `5` | Jobs processed per scheduler run before stopping, even if more are queued. |
| `WORKER_HEARTBEAT_INTERVAL` | `15000` (ms) | How often an actively-running job's heartbeat is touched, and the standalone process's default wake interval. |

All three are read fresh by `src/lib/config/worker-config.ts` — no
restart-order dependency, no secret ever logged.

## Atomic claim

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

## Polling stays read-only

`GET /api/projects/[projectId]/generation/status` (and the
`ConversationCapability` layer behind it) only ever reads status. It never
recovers a job, never claims work, and never triggers generation — that
guarantee is enforced by `getGenerationStatus` and locked in by
`conversation-service.test.ts`.

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
