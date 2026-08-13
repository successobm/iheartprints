# Production deployment

This is the authoritative production deployment procedure for iHeartPrints.

It records **verified** hosting facts. Domain architecture remains in
[`ARCHITECTURE.md`](./ARCHITECTURE.md). Worker *scheduling* topologies remain
in [`docs/deployment/generation-worker.md`](./docs/deployment/generation-worker.md)
and [`docs/deployment/final-artwork-worker.md`](./docs/deployment/final-artwork-worker.md).

Do not treat the leftover create-next-app “Deploy on Vercel” language as
product intent. Production is DigitalOcean App Platform.

## Production host

DigitalOcean App Platform

## Application

`iheartprints`

## Source repository

`successobm/iheartprints`

## Production branch

`main`

## Production URL

[https://iheartprints-88sjr.ondigitalocean.app/](https://iheartprints-88sjr.ondigitalocean.app/)

This is the DigitalOcean-generated App Platform domain (`*.ondigitalocean.app`),
not a custom domain. HTTPS is terminated in front of the app (Cloudflare in
front of App Platform). `GET /` returns `200` with `x-powered-by: Next.js` and
`x-do-app-origin`.

## Deployment trigger

Pushes to `main` trigger the DigitalOcean App Platform deployment through the
GitHub source connection.

This was empirically verified when DigitalOcean checked out, built, and
deployed:

```text
bbc79795951c589d188131be6287c226e9ce7c87
```

(`merge: v1 finalization acceptance`)

Status for that deployment: Success / Healthy / live.

## Build

DigitalOcean executes:

```bash
npm run build
```

That is the repository production build (`next build`).

## Runtime

Repository start script (`package.json`):

```bash
npm start
```

which runs `next start`.

App Platform is serving the Next.js production server (verified by response
headers on `GET /`). The exact App Platform `run_command` field was not
readable from this repository (there is no in-repo `app.yaml` / `.do/` spec);
do not invent a second start command.

The web process is **not** the production worker. Interactive `next dev`
local auto-triggers do not run in production. See
[`docs/deployment/generation-worker.md`](./docs/deployment/generation-worker.md)
and [`docs/deployment/final-artwork-worker.md`](./docs/deployment/final-artwork-worker.md).

## Environment variables

Names only. Never commit values. Never log values.

The following names are used by current code and were present on the
DigitalOcean App Platform app at the V1 finalization deployment:

| Name | Role |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Required server persistence/storage key when a Supabase URL is set. If the URL is set and this is missing, the app **fails closed** rather than falling back to the local on-disk store |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Present on the app; **not** sufficient for server table/storage access |
| `ASSET_STORAGE_MODE` | Asset backend (`supabase_storage` required for real production images) |
| `CONCEPT_GENERATION_ENABLE_REAL` | Kill switch for paid OpenAI concept generation |
| `CONCEPT_EVALUATION_PROVIDER` | Concept Evaluation adapter (`placeholder` or `openai`) |
| `OPENAI_API_KEY` | Server-only; concept generation and evaluation |
| `OPENAI_EVALUATION_MODEL` | Concept Evaluation model |
| `WORKER_SECRET` | Required in production for `POST /api/worker/*` |
| `FINAL_ARTWORK_PROVIDER` | `local` or `topaz` |
| `TOPAZ_API_KEY` | Required when `FINAL_ARTWORK_PROVIDER=topaz` |

Related names also used by the codebase (see `.env.example` and
`ARCHITECTURE.md` §21): `CONCEPT_GENERATION_PROVIDER`, `OPENAI_IMAGE_MODEL`,
`CONVERSATION_UNDERSTANDING_PROVIDER`, `MAX_GENERATION_JOBS_PER_RUN`,
`WORKER_HEARTBEAT_INTERVAL`.

## Migrations

Schema changes live in `supabase/migrations` and follow
[`docs/database/MIGRATION_WORKFLOW.md`](./docs/database/MIGRATION_WORKFLOW.md).

App Platform deploy of `main` does **not** automatically apply SQL migrations.
There is no in-repo production migration job.

The V1 finalization merge (`bbc7979`) required **no** migration.

## Release verification procedure

1. Merge verified feature work into `main` with a normal merge commit (`--no-ff` unless repository convention changes).
2. Push `main` to `origin`.
3. In DigitalOcean App Platform, confirm the deployment checked out the expected commit SHA.
4. Confirm deployment status is Success / Healthy / live.
5. Run an **unpaid** production smoke:
   - `GET https://iheartprints-88sjr.ondigitalocean.app/` → `200`
   - a safe read of an existing project or status route (no new projects, no finalize, no worker POST)
6. Do **not** repeat paid OpenAI or Topaz acceptance solely to verify a deployment.

If DigitalOcean rebuilds for a docs-only push, that is expected. Re-check
Success/Healthy and `GET /`. Do not start another final-artwork job.
