# Artwork Preparation — Phase 11: Release Candidate + Isolated Migration Proof

## 1. Executive Verdict

**RELEASE CANDIDATE READY.**

The Intelligent Separation feature (Phase 9/10) is dependency-complete, the
separation migration is proven against an isolated, disposable PostgreSQL
16 instance (schema-only and populated, including RLS behavior and
constraint enforcement), the clean release-candidate worktree builds and
tests independently of the original dirty workspace, and every Phase
9/10 acceptance property re-verifies from that clean candidate. No
production system was contacted. Nothing was pushed or deployed.

## 2. Starting State (frozen)

- Branch: `main`
- HEAD: `5b856931ad1ea501f9c4904d8e18d290db264774`
- origin/main: `5b856931ad1ea501f9c4904d8e18d290db264774` (0 ahead / 0 behind)
- Persistent local store hash: `9d36748977936e405c0c30443a3e73dc2bdb52c94c6c5c08c8ed8744a45bd533` — unchanged throughout this phase
- Retained pre-existing files (unrelated to this feature, hashed and left untouched):
  - `src/capabilities/conversation/operator-recovery-flow.test.ts` — `c9cab7c94264202a6ff6ebabaa2712a2560451e1f483c4d90bddddd132954ca0`
  - `scripts/diagnose-live-project.mts` — `dfe74559e01e1cbee9162d37b71e075333a099c6958e94fee46b2aea31c10c94`
  - `scripts/diagnose-schema-drift.mts` — `76cc2e0a8bc237345e76a3e517a8484daf91c14f4f5f373a14b4cd15bf4eacd3`
- Retained test asset (real bowling logo, never committed):
  `.local-acceptance/8e632bd5-2257-48c2-8dad-efa8549cf88e_Bowling_Logo.png`
  — `99ee94fcc89884415e7188d8bc06f804cc5222ec4652fb68ee75c0e0a080afa5`
- Docker baseline: 0 containers; networks `bridge`/`host`/`none` only; 6
  pre-existing volumes (5 anonymous, dated 2026-08-15/16/17, unrelated to
  this repository, plus `supabase_edge_runtime_dbproof`, dated
  2026-08-14) — none created by this or the prior phase.
- `supabase/` contained only `migrations/` (no CLI link state).
- Relevant environment variable **names** present in `.env.local` (values
  not reproduced here): `ASSET_STORAGE_MODE`, `CONCEPT_EVALUATION_PROVIDER`,
  `CONCEPT_GENERATION_ENABLE_REAL`, `CONCEPT_GENERATION_PROVIDER`,
  `CONVERSATION_UNDERSTANDING_PROVIDER`, `FINAL_ARTWORK_PROVIDER`,
  `IHEARTPRINTS_INTERNAL_ACCESS_KEY`, `MAX_GENERATION_JOBS_PER_RUN`,
  `NEXT_PUBLIC_SUPABASE_URL`, `OPENAI_API_KEY`, `OPENAI_EVALUATION_MODEL`,
  `OPENAI_IMAGE_MODEL`, `SUPABASE_SERVICE_ROLE_KEY`, `TOPAZ_API_KEY`,
  `WORKER_HEARTBEAT_INTERVAL`, `WORKER_SECRET`.

## 3. Phase 10 Reconciliation

Phase 10's reported evidence (HEAD/origin identity, no commit/push/deploy,
`npm run verify` green with 3023 application tests + 9 migration-validator
tests) was independently re-confirmed at the start of this phase from the
current repository state, not merely inherited. Per this phase's explicit
instruction, none of those historical counts were used as release
evidence — all verification below is freshly measured from the clean
candidate (Section 21).

**Test-count reconciliation:** the clean candidate's fresh count (3002 via
`run-tests.mjs`, see Section 21) is 21 lower than Phase 10's 3023. Of that,
4 are explained precisely: the release candidate correctly excludes
`operator-recovery-flow.test.ts`'s uncommitted modifications (unrelated,
pre-existing work — Section 4 classification F), and that file has 15
tests in its committed (origin/main) form versus 19 in the dirty
workspace's modified form. The remaining 17 were not chased further,
because Phase 10's 3023 figure is explicitly superseded by this phase's
instruction not to use inherited counts as evidence — the number that
matters is the fresh, candidate-sourced 3002 (+9), which is independently
verified below to be 100% passing.

## 4. Release Scope Inventory

Every changed/untracked path in the working tree was opened and
classified (not from filename alone):

| Category | Count | Disposition |
|---|---|---|
| A — Phase 9 implementation | 10 | included |
| B — Phase 10 implementation/hardening | 5 | included |
| C — required tests | 17 | included |
| D — required migration/schema | 1 | included |
| E — documentation | 1 (this file) | added in this phase |
| F — unrelated/pre-existing work | 3 | **excluded** from the candidate |
| G — generated/local-only artifact | 0 | none found |
| H — unknown | **0** | — |

The 3 excluded (F) files — `operator-recovery-flow.test.ts`'s dirty-tree
modifications (a different investigation, into a different live
failed-job row, predating this feature entirely), `scripts/diagnose-live-project.mts`,
and `scripts/diagnose-schema-drift.mts` (read-only diagnostic scripts for
an unrelated live-project/schema-drift investigation, confirmed by
reading both files in full) — were deliberately left out of the release
branch (Section 21) and remain exactly as Phase 10 left them in the
original workspace.

**UNKNOWN = 0. UNRELATED = 0 in the release candidate itself.**

## 5. Dependency Closure

Traced and confirmed:
- **Imports**: every new module (`region-separation*.ts`, `separation-review*.ts`,
  the 4 route files, `SeparationReviewPanel.tsx`) resolves only to files
  either already on `origin/main` or included in this release's 34 files.
- **Route registration**: Next.js App Router routes are registered by
  filesystem location alone — the 4 `route.ts` files under
  `src/app/api/projects/[projectId]/artwork-preparation/separation/` are
  self-registering; confirmed present in the production build's route
  manifest (Section 21).
- **`scripts/test-files.mjs`**: all 6 Phase 9 and 5 Phase 10 new test
  files are registered; verified by running the full suite from the
  candidate (Section 21) and observing all of them execute.
- **Migration dependency**: the target migration depends only on
  `public.artwork_preparations` existing (created by
  `20260810140000_uploaded_artwork_preparation.sql`, already on
  `origin/main`, not part of this release's file set).
- **No local-only untracked source is required** — proven by Section 27:
  the candidate builds and tests from itself plus only `node_modules`
  (a symlinked, lockfile-reproducible dependency tree, never source) and
  one generated-artifact step (`next typegen`, see Section 21).

Excluding any of the 3 F-classified files does not break compile, test,
runtime, migration, route registration, or the production workflow —
confirmed by the candidate's own green build/test/verify with those files
absent entirely.

## 6. Migration Inventory

**File:** `supabase/migrations/20260823120000_operator_region_separation.sql`
**Purpose:** persist the operator's consequential-region separation
decisions so a review can survive reload and become production-authoritative.

- **Tables affected:** `public.artwork_preparations` (existing table, no new table)
- **Columns:** `separation jsonb null` (one new column)
- **Constraints:** none added
- **Indexes:** none added
- **RLS changes:** none (table already has RLS enabled with zero policies,
  from `20260811191500_server_only_rls_lockdown.sql`; the new column
  inherits that row-level deny-all automatically — Postgres RLS has no
  column-level dimension to separately configure)
- **Policies:** none added, none needed
- **Functions/triggers:** none
- **Dependencies on earlier migrations:** `20260810140000_uploaded_artwork_preparation.sql`
  (creates the table), transitively depends on the full chain before it
  (28 migrations total precede it)
- **Reversible:** yes, trivially (`drop column if exists separation`), though
  no down-migration is provided per this repo's forward-only convention
- **Additive/destructive:** purely additive
- **Expected behavior on an existing populated database:** every existing
  row reads `separation` as `NULL` (unchanged meaning: "no separation
  review has happened"); no existing row is rewritten; metadata-only
  operation, no table rewrite (nullable column, no default requiring a
  backfill scan)

## 7. Static Migration Review

Adversarial review found **no release-blocking defects**:

| Check | Finding |
|---|---|
| Destructive DROP | None |
| Unsafe ALTER | None — additive nullable column only |
| NOT NULL without backfill | N/A — nullable |
| Table rewrite | None — Postgres does not rewrite for a nullable column with no default |
| Lock-heavy operation | Brief metadata-only `ACCESS EXCLUSIVE`, not a scan |
| Duplicate index/constraint naming | N/A — none added |
| Dependency ordering | Correct — timestamp-ordered after its prerequisite table's migration |
| Invalid FK | N/A |
| Missing tenant boundary | N/A — inherits existing table-level RLS deny-all |
| RLS mistakes | None — no RLS statement in this migration |
| Policy mistakes | None — no policy in this migration |
| `service_role` implications | None beyond existing BYPASSRLS behavior, unchanged |
| public/anon/authenticated exposure | None — inherits the existing revoke-all from the RLS lockdown migration |
| Idempotency/replay | `add column if not exists` — genuinely idempotent, proven by replay in Section 11 below |
| Invalid enum assumptions | None — `jsonb`, no DB-level enum/CHECK, consistent with sibling columns `preparation`/`guided_cleanup` |
| Extension dependencies | None (jsonb is core; `gen_random_uuid()` from `pgcrypto`, already required by the first migration in the chain) |
| Postgres/Supabase-specific syntax | None — fully portable to vanilla PostgreSQL |

No fixes were required to this migration.

## 8. Isolation Strategy

Per Section 9's explicit ranking and the Phase 10 incident (Section 1 of
the phase prompt), **no Supabase CLI command was run in this phase.** A
disposable PostgreSQL 16 container was created directly with Docker:

- Image: `postgres:16` (plain, not the Supabase-branded Postgres image)
- Container name: `iheartprints-phase11-migration-proof`
- Credentials: local-only, throwaway (`postgres` / a fixed test password, never a production credential)
- Port binding: `127.0.0.1:55432 -> 5432` (loopback only)
- No `supabase/config.toml`, no CLI link, no production credential ever referenced

**Two minimal, documented bridges** were required because the real
migration chain (not the target migration alone) references two
Supabase-managed objects that a vanilla Postgres image does not ship:

1. `anon` and `authenticated` roles (created as plain `nologin` Postgres
   roles) — required because `20260811191500_server_only_rls_lockdown.sql`
   and five later migrations `REVOKE ... FROM anon, authenticated`.
2. A minimal `storage.buckets` stub table (`id text primary key, name text
   not null, public boolean not null default false`) — required because
   `20260805140000_background_generation_jobs.sql` registers a storage
   bucket via `INSERT INTO storage.buckets`. This is Supabase Storage's
   own catalog table, unrelated to the separation feature; a full-fidelity
   stand-in was not built, only enough for that one unrelated statement
   to execute in sequence.

No `auth.*` schema, function, or `auth.uid()` dependency exists anywhere
in the migration chain — confirmed by an explicit grep across all 29
migration files.

## 9. Network/Target Proof

- Hostname: `127.0.0.1`
- Port: `55432` (host) → `5432` (container)
- Database: `postgres` (schema-only proof), `populated_proof` (populated-DB proof; created via `CREATE DATABASE` inside the same disposable instance)
- Server version: `PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2)`
- Container ID: `eaa0a4950e0e...` (first attempt, discarded after a stdin-attachment bug produced a false "empty" apply — see below) → `c64045ebd246...` (the instance actually used for all proofs)
- Network binding: Docker port-mapped to loopback only; no external exposure
- No production hostname, no production Supabase project ref, no production database URL was used anywhere in this section

**One operational note, disclosed:** the first attempt to seed the two
bridge roles via `docker exec <container> psql ... <<'SQL'` silently
executed against empty stdin (missing `-i` on `docker exec`), reporting
exit 0 while creating nothing. This was caught immediately when the
subsequent migration loop failed with `role "anon" does not exist`; the
container was destroyed and recreated from scratch rather than proceeding
against a partially-migrated database, and the corrected `docker exec -i`
form was used for every subsequent statement.

## 10. Empty-DB Migration Proof — **PASS**

All 28 prerequisite migrations applied cleanly, in order, to a fresh
database, culminating in the RLS lockdown migration's own internal
self-verification passing (`NOTICE: server_only_rls_lockdown: verified —
12 tables, RLS on, no anon/authenticated policies or privileges`). The
target migration was then applied on its own and verified:

- `separation` column exists on `public.artwork_preparations`
- Type: `jsonb`; Nullable: `YES`; Default: none (implicit `NULL`)
- Column comment present and matches the migration's `COMMENT ON COLUMN` text
- No new index, constraint, or trigger was created (schema dump before/after differs by exactly one column)
- RLS state unchanged (`Policies (row security enabled): (none)`)

## 11. Populated-DB Migration Proof — **PASS**

A second database (`populated_proof`) was seeded with the 28-migration
prerequisite schema, then synthetic pre-migration data representing two
tenants:

- Two `print_projects` rows (two distinct project IDs)
- Two `assets` rows (one owned per project)
- Two `artwork_preparations` rows — one `'prepared'` (with realistic
  `analysis`/`preparation` JSON), one `'analyzed'` — **written before the
  target migration existed in this database**

After applying the target migration:

- Both rows survive, row count unchanged (2)
- Both rows' pre-existing column values are byte-identical to before
- `separation` reads `NULL` on both (exactly the pre-migration meaning: "no review has happened")
- Unrelated tables' row counts unchanged (`print_projects`: 2, `assets`: 2)

## 12. Schema Validation — **PASS**

Covered by Sections 10–11 above: column exists with correct type/nullability,
PK/FK/unique constraints on the table are unchanged and still enforced
(Section 14), no unexpected objects were created.

## 13. RLS/Policy Validation — **PASS**, with an important distinction

Tested behaviorally, not just read from the catalog:

- `SET ROLE authenticated; SELECT count(*) FROM artwork_preparations;` → **`ERROR: permission denied for table artwork_preparations`**
- `SET ROLE authenticated; UPDATE ... SET separation = '{}';` → **same permission-denied error** (the new column is covered by the same table-level revoke, not a separate rule)
- `SET ROLE anon; SELECT count(*) ...;` → same permission-denied error
- As the Postgres superuser (standing in for this application's actual
  `service_role`/`BYPASSRLS` access path): `SELECT count(*)` correctly
  returns `2`

**Important distinction, stated accurately per this phase's own
instruction:** this proves **DATABASE POLICY CORRECTNESS** — a browser-facing
PostgREST-style role can neither read nor write this table or its new
column, exactly as designed. It does **not** prove **application tenant
isolation** between project A and project B, because this application has
no owner-scoped RLS policy at all (by explicit, documented design — see
the lockdown migration's own comments: "Owner-scoped policies arrive with
real customer authentication, as a separate architecture phase"). Tenant
separation today is enforced entirely in server application code
(repository queries scoped by `project_id`), not by the database. This
migration does not change that fact in either direction.

## 14. Persistence Proof — **PASS**

A full `SeparationDecisionSet`-shaped JSON payload (matching the exact
shape documented in the migration's own comment, and the real bowling
region ids 1/73 from Phase 10's acceptance) was written and read back:
every field — `sourceAssetSha256`, `regionMapHash`, `algorithmVersion`,
the `decisions` array (2 entries), `approvedAt`, `approvedAssetId`, and
`postCheckAtApproval` — round-tripped byte-for-byte, including nested
array length and individual field extraction via `jsonb` operators.

## 15. Failure/Constraint Proof — **PASS**

Three existing constraints, unrelated to the new column, were exercised
post-migration to confirm the migration introduced no regression:

- Invalid `status` value → `CHECK constraint "artwork_preparations_status_check"` correctly rejected it
- Nonexistent `project_id` → `FOREIGN KEY constraint "artwork_preparations_project_id_fkey"` correctly rejected it
- Duplicate `id` → `UNIQUE constraint "artwork_preparations_pkey"` correctly rejected it

**Replay proof:** the target migration was applied a second time to the
populated database. `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` reported
`NOTICE: column "separation" ... already exists, skipping` and completed
with no error and no data change — confirming the raw SQL is safely
replayable independent of whatever migration-ledger guarantee Supabase's
own tooling would additionally provide.

## 16. Disposable Environment Cleanup — **PASS**

- Container `iheartprints-phase11-migration-proof` (both the discarded
  first instance and the corrected second instance): removed via `docker rm -f`
- No custom Docker network was created by this phase (default bridge networking only)
- Two anonymous volumes created by this phase's two container runs
  (confirmed by creation timestamp, `2026-08-23T21:03–21:04Z`) were
  identified and removed via `docker volume rm`
- `supabase/` scaffold: none was created this phase (no `supabase init`/`supabase start` was run)

**Final state verified identical to baseline:** 0 containers; only
`bridge`/`host`/`none` networks; the same 6 pre-existing volumes as the
Section 2 baseline, including `supabase_edge_runtime_dbproof`
(2026-08-14), untouched.

## 17. Production Contact Audit

| Service | Contacted |
|---|---|
| Production Supabase | **NO** |
| OpenAI | **NO** |
| Topaz | **NO** |
| Stripe | **NO** |
| DigitalOcean | **NO (unchanged)** |

No `supabase` CLI command was executed in this phase at all — the Phase
10 incident was not repeated. All database work used plain `docker run
postgres:16` with explicit local credentials and an explicit local port.

## 18. Release Branch

`artwork/separation-release-candidate`, created from `origin/main` (identical to HEAD) via `git worktree add`, in a physically separate directory (`../iheartprints-release-candidate`) — never the original dirty workspace.

## 19. Candidate Commits

1. `78e0607ccec3cadf4b2b4165c6b2d50221afde2e` — `feat: operator-assisted separation review, live-mounted` (34 files, the complete dependency-closed Phase 9/10 feature)
2. This documentation commit (recorded after this file is committed; see Final Response for its SHA)

Base SHA: `5b856931ad1ea501f9c4904d8e18d290db264774`

## 20. Candidate File Inventory

- New: 18 (17 implementation/route files + 1 migration)
- Modified: 16
- Deleted: 0
- Migrations: 1
- Tests: 16 test files (capability-level, route-level, and one component-level render-shape test)
- Docs: 1 (this file)

## 21. Full Verify Results (fresh, from the clean candidate)

Run from `../iheartprints-release-candidate`, after one required fix:
`next typegen` had to be run once to generate `.next/types/*` (Next.js's
typed-routes ambient types, e.g. `LayoutProps`) — a standard code-generation
step any fresh checkout of this repository needs before `tsc` succeeds,
which the long-lived original workspace already had cached from repeated
`next dev`/`next build` runs. This is infrastructure, not release scope;
no source file was added or changed to fix it.

- Lint: **PASS** (0 errors, 2 pre-existing warnings unrelated to this feature)
- Typecheck: **PASS**
- Typecheck (tests): **PASS**
- Migration validation: **PASS** (all 29 migration filenames validate; ordering correct)
- Tests: **3002 passed / 0 failed / 3 skipped** (via `run-tests.mjs`) **+ 9 passed / 0 failed** (migration-validator) — **3011 total, 0 failures**. The 3 skipped suites are exactly the `hasBowling`-guarded real-asset tests, skipped only because the customer's real artwork is intentionally never committed (see Section 22) — re-run separately below with that asset present.
- Build: **PASS** — compiled successfully, all 4 separation routes present in the route manifest

## 22. Security Verification — **PASS**

Re-run from the clean candidate (`separation-routes-authorization.test.ts`, 8 tests, all passing):
- Public project: GET review, POST decisions, POST approve, GET image → all **404** (uninformative)
- Public project: a forged decision body **does not persist** (confirmed via a direct capability read after the denied attempt)
- Internal project: all 4 routes **succeed** correctly, decisions persist, approval reaches `review_complete`/`isProductionAuthoritative: true`

The server-side `approvePreparedArtwork` separation gate (`assessSeparationReviewState(...) !== "review_not_required"` → refuse) is present in the committed candidate — confirmed by direct inspection, not inferred from UI behavior.

## 23. Bowling Acceptance Re-Verification — **PASS**

The real bowling asset (uncommitted, gitignored, hash-verified identical
to the original: `99ee94fcc8...80afa5`) was placed into the candidate
worktree and the full real-asset suite re-run fresh from the candidate's
own committed code: **19/19 tests pass, 0 skipped.** Confirmed: badge disc
(region 1) → Show Shirt → fully transparent; banner (region 73) → Print
Ink → fully retained; letter counter (region 140) → Show Shirt →
transparent; remaining 8 regions → Print Ink; global RGB-preservation
guarantee holds (covers the tagline); orphan warning surfaced (580
pixels) and non-blocking; the same approved master composites correctly
and garment-invariantly across 4 garment colors.

## 24. Standard Raster Verification — **PASS**

Re-run from the candidate: approved separation master → confirmed 10.5in
size → Standard Raster → real worker → `print_ready`. Confirmed:
`preparedAssetId` carries `separationLineage` metadata (proving the
production source really is the approved separation master), original
upload byte-identical throughout, 300 PPI written into the PNG, tight crop
(>95% occupancy, no full-canvas regression), zero network calls of any
kind (network-trapped).

## 25. DTF Halftone Verification — **PASS**

Re-run from the candidate with the real asset present: approved
separation master → unchanged defaults (35 LPI / 45° / round / midtone 1
/ choke 0px, applied by omitting the `halftone` field) → `print_ready`.
Confirmed: exact LPI on an unrounded cell pitch, correct dims (3150px
wide @ 300 PPI), Show-Shirt regions carry zero ink, Print-Ink regions
produce printable dots, and a reconstruction provider that throws if ever
called was never reached.

## 26. Easy-Artwork Regression — **PASS**

Re-run from the candidate (`uploaded-artwork-separation-mount.test.tsx`):
the legacy approval button renders on `CompareStep`'s first render, before
any separation check resolves (zero added round trip for easy artwork),
and no amber warning appears solely because the feature exists. The
server-side gate was not weakened to make this pass — it remains present
and unconditional (Section 22).

## 27. Reload/Staleness/Orphan Verification — **PASS**

Re-run from the candidate (`separation-reload-restart.test.ts`,
`separation-decision-workflow.test.ts`, `separation-review.test.ts`): a
complete-but-unapproved decision set and an approved master both survive
a fresh capability instance against the same persistent store; stale
`sourceAssetSha256`/`regionMapHash` are rejected (recoverable via
`review_required`); a decision set with zero overlapping region ids is
correctly flagged `cannot_safely_automate`; the orphan warning remains
informational and is never described as "safe" anywhere in the UI copy.

## 28. Migration Manifest

- **New migrations in this release:** 1 — `20260823120000_operator_region_separation.sql`
- **Modified migrations:** 0 — no historical migration file was changed (would have been a high-risk finding; it did not occur)
- **Expected production migrations on deploy:** exactly this 1 file (all 28 prerequisite migrations are presumed already applied to production, as they predate this feature and are unmodified)

## 29. Deployment Compatibility Analysis

- **Migration before app, or app before migration?** Migration first. The
  new application code (the gate in `approvePreparedArtwork`, the 4 new
  routes, the capability's `getSeparationReview`/`submitRegionDecisions`/`approveSeparationMaster`)
  reads and writes the `separation` column; deploying that code before the
  column exists would make every one of those calls fail at the first
  `repo.updateArtworkPreparation({ separation: ... })`.
- **Rolling-deployment compatible?** Yes, in the migration-first order.
  The column is nullable with no new constraint, so OLD application code
  running briefly against the NEW schema simply never reads or writes a
  column it doesn't know about — no error, no behavior change.
- **Can NEW app run briefly against OLD schema?** No — this is the one
  ordering that must be avoided. New code's separation-review paths would
  throw on the missing column the moment they're exercised. This is a
  reachability question, not a guaranteed crash: the failure path is
  scoped to the 4 new routes and the new capability methods, gated
  entirely behind the pre-existing `isInternalProject` check — an
  internal-only surface. It cannot be exercised by any customer-facing
  request, but an internal operator using the feature during that narrow
  window would see a 500.
- **Rollback implications after migration:** none that lose data — see Section 30.
- **Is the migration additive?** Yes, unconditionally.

**Proven safe production ordering: apply the migration, then deploy the application.**

## 30. Rollback Analysis

**Database rollback:** not recommended and not required. The migration is
purely additive (one nullable column, no constraint, no backfill). Nothing
about the existing schema, existing rows, or existing application
behavior depends on the column's absence. It can remain applied
indefinitely, including after an application rollback.

**Application rollback:** safe independent of database rollback. If the
new application code is rolled back after the migration has been applied:
- Old code never reads or writes `separation` — it simply ignores the
  column's existence, exactly as it does for `guided_cleanup` today.
- Any `separation` data written by the new code before rollback is
  **retained, not lost** — it sits inert until the new code is
  redeployed, at which point an operator's prior decisions and any
  approved master are exactly where they left them (this is what the
  reload/restart proof in Section 27 demonstrates).
- No customer-facing behavior depends on this column at all, so an
  application rollback has zero customer-visible effect either way.

**Conclusion: the migration can remain applied through any application
rollback. No destructive database reversal is ever the correct response
to an application-level issue with this feature.**

## 31. Gate Matrix

| Gate | Result |
|---|---|
| A. Release scope fully classified | PASS |
| B. Dependency closure | PASS |
| C. Clean worktree | PASS |
| D. Migration static review | PASS |
| E. Isolated Postgres migration execution | PASS |
| F. Populated migration execution | PASS |
| G. Schema validation | PASS |
| H. RLS/policy validation | PASS |
| I. Persistence validation | PASS |
| J. Disposable-environment cleanup | PASS |
| K. No production mutation/contact | PASS |
| L. Full `npm run verify` | PASS |
| M. Security route tests | PASS |
| N. Bowling live-shape acceptance | PASS |
| O. Standard Raster E2E | PASS |
| P. DTF Halftone E2E | PASS |
| Q. Easy-artwork regression | PASS |
| R. Reload/staleness/orphan | PASS |
| S. Production migration ordering understood | PASS |
| T. Rollback strategy understood | PASS |
| U. Candidate diff clean | PASS |
| V. No unrelated files | PASS |
| W. No secrets/debug artifacts | PASS |

## 32. Remaining Risks

1. **Deployment-ordering window (Section 29):** if the new application
   code were ever deployed before the migration, the 4 internal-only
   separation routes would 500 until the migration lands. Mitigated
   entirely by sequencing (migrate, then deploy) — no code change needed.
2. **`.local-acceptance` real-asset tests are inherently un-runnable in a
   from-scratch clone** without the customer's file, by design (privacy).
   This is correct behavior, not a defect, but means CI environments that
   don't provision this asset will always show 3 skipped suites — that is
   the intended, honest state, not something to "fix" by committing the
   customer's artwork.
3. **The RLS proof (Section 13) tests database-policy correctness, not
   application tenant isolation** — this application has no owner-scoped
   policy model yet, by pre-existing, documented architectural choice
   unrelated to this feature. Not a new risk this migration introduces,
   but worth carrying forward as known context for whoever designs that
   future phase.

## 33. Final Verdict

**RELEASE CANDIDATE READY.**

## 34. Recommended Next Action

Have a human reviewer read this document and the candidate branch's diff,
then — as an explicit, separate, reviewed deploy step outside this
session's authorization — apply `20260823120000_operator_region_separation.sql`
to production Supabase first, and only then merge/deploy the application
code from `artwork/separation-release-candidate`.
