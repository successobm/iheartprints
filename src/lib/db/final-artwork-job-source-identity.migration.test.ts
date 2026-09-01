import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * LIVE PRODUCT BLOCKER #4E: deterministic, offline assertions about the
 * SQL intent of the source-identity fix in
 * `supabase/migrations/20260901040000_final_artwork_job_source_identity.sql`.
 *
 * This mirrors `security-lockdown.migration.test.ts`'s own stated
 * philosophy: inspect migration SQL text so the guarantee runs on every
 * machine with zero infrastructure, on every `npm run verify`. It proves
 * the migration's *intent* is correct and does not regress.
 *
 * It does NOT and cannot prove PostgreSQL actually enforces the resulting
 * FK/CHECK at runtime — no live Postgres/Supabase driver or local stack
 * exists in this repository to connect to (confirmed by audit: no
 * `supabase/config.toml`, no `DATABASE_URL`/`SUPABASE_DB_URL`, no `pg`
 * dependency). That behavioral proof was instead performed once, live,
 * directly against the linked production Supabase database via
 * PostgREST immediately after applying the migration — attempting the
 * exact valid/invalid inserts this test's assertions describe, and
 * cleaning up any row it created — and is reported in the #4E phase
 * report rather than re-run automatically (this repository has no
 * mechanism to run such a probe safely and repeatably in CI or on a
 * contributor's machine without live credentials).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const SOURCE_IDENTITY_MIGRATION =
  "20260901040000_final_artwork_job_source_identity.sql";
const ORIGINAL_TABLE_MIGRATION = "20260806190000_final_artwork_lifecycle.sql";
const SIGN_AUTHORITY_MIGRATION = "20260830130000_sign_final_artwork_authority.sql";

function migrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** Same CRLF/comment-stripping approach as security-lockdown.migration.test.ts. */
function sqlWithoutComments(sql: string): string {
  return sql
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();
}

function readSqlWithoutComments(filename: string): string {
  return sqlWithoutComments(
    readFileSync(path.join(MIGRATIONS_DIR, filename), "utf8"),
  );
}

const migrationSql = readSqlWithoutComments(SOURCE_IDENTITY_MIGRATION);

describe("final_artwork_job_source_identity migration", () => {
  it("exists and sorts after the sign authority migration it corrects", () => {
    const names = migrationFilenames();
    assert.ok(
      names.includes(SOURCE_IDENTITY_MIGRATION),
      `${SOURCE_IDENTITY_MIGRATION} is missing`,
    );
    assert.ok(
      names.indexOf(SOURCE_IDENTITY_MIGRATION) >
        names.indexOf(SIGN_AUTHORITY_MIGRATION),
      "source-identity fix must sort after the migration that introduced the defect",
    );
    assert.ok(
      names.indexOf(SOURCE_IDENTITY_MIGRATION) >
        names.indexOf(ORIGINAL_TABLE_MIGRATION),
      "source-identity fix must sort after the table's original creation",
    );
  });

  it("relaxes artwork_version_id's NOT NULL constraint", () => {
    assert.match(
      migrationSql,
      /alter\s+table\s+public\.final_artwork_jobs\s+alter\s+column\s+artwork_version_id\s+drop\s+not\s+null/,
      "migration must drop the NOT NULL constraint on artwork_version_id",
    );
  });

  it("does NOT drop or weaken the artwork_version_id foreign key itself", () => {
    // The FK to artwork_versions must remain — only nullability changes.
    // A correct fix never touches `drop constraint ... artwork_version_id_fkey`.
    assert.ok(
      !migrationSql.includes("drop constraint if exists final_artwork_jobs_artwork_version_id_fkey"),
      "migration must not drop the artwork_version_id foreign key — DTF referential integrity must remain",
    );
  });

  it("does NOT add a new source-identity column (sign_preparation_id already exists)", () => {
    assert.ok(
      !/add\s+column\s+(?:if\s+not\s+exists\s+)?sign_preparation_id/.test(migrationSql),
      "sign_preparation_id already exists from 20260830130000 — this migration must not redeclare it",
    );
  });

  it("does NOT manufacture placeholder artwork_versions rows", () => {
    assert.ok(
      !migrationSql.includes("insert into public.artwork_versions"),
      "migration must not insert fake artwork_versions rows to satisfy the old FK",
    );
  });

  it("does NOT rewrite any historical final_artwork_jobs data", () => {
    assert.ok(
      !migrationSql.includes("update public.final_artwork_jobs"),
      "migration must be schema-only — no UPDATE against existing rows",
    );
  });

  it("rebuilds final_artwork_jobs_exactly_one_authority as a single non-redundant CHECK", () => {
    const dropCount = (
      migrationSql.match(
        /drop\s+constraint\s+if\s+exists\s+final_artwork_jobs_exactly_one_authority/g,
      ) ?? []
    ).length;
    const addCount = (
      migrationSql.match(
        /add\s+constraint\s+final_artwork_jobs_exactly_one_authority\s+check/g,
      ) ?? []
    ).length;
    assert.equal(dropCount, 1, "must drop the existing CHECK exactly once before rebuilding it");
    assert.equal(addCount, 1, "must add exactly one replacement CHECK — no separate, possibly-drifting XOR constraint");
  });

  it("the create_new (final_direction_approval) arm requires artwork_version_id", () => {
    const arm = extractArm(migrationSql, "final_direction_approval_id is not null");
    assert.match(arm, /artwork_version_id is not null/);
  });

  it("the prepared_upload arm requires artwork_version_id", () => {
    const arm = extractArm(migrationSql, "artwork_preparation_id is not null");
    assert.match(arm, /artwork_version_id is not null/);
  });

  it("the sign_preparation arm requires artwork_version_id to be NULL", () => {
    const arm = extractArm(migrationSql, "sign_preparation_id is not null");
    assert.match(arm, /artwork_version_id is null/);
  });

  it("every arm still governs its own three authority-column exclusivity as before", () => {
    // Regression guard: the #4E fix adds a 4th condition per arm but must not
    // drop any of the original 3-4 conditions each arm already enforced.
    const createNewArm = extractArm(migrationSql, "final_direction_approval_id is not null");
    assert.match(createNewArm, /artwork_preparation_id is null/);
    assert.match(createNewArm, /sign_preparation_id is null/);
    assert.match(createNewArm, /production_width_in is null/);

    const preparedUploadArm = extractArm(migrationSql, "artwork_preparation_id is not null");
    assert.match(preparedUploadArm, /final_direction_approval_id is null/);
    assert.match(preparedUploadArm, /sign_preparation_id is null/);
    assert.match(preparedUploadArm, /production_width_in is not null/);

    const signArm = extractArm(migrationSql, "sign_preparation_id is not null");
    assert.match(signArm, /final_direction_approval_id is null/);
    assert.match(signArm, /artwork_preparation_id is null/);
    assert.match(signArm, /sign_plan_key is not null/);
  });
});

/**
 * Pulls the parenthesized OR-arm containing `marker` out of the CHECK
 * constraint body, for arm-scoped assertions. The three arms are
 * syntactically parallel `( ... ) or ( ... ) or ( ... )` groups.
 */
function extractArm(sql: string, marker: string): string {
  const checkStart = sql.indexOf("final_artwork_jobs_exactly_one_authority check");
  assert.ok(checkStart >= 0, "CHECK constraint not found");
  const body = sql.slice(checkStart);
  const arms = body.split(/\)\s*or\s*\(/);
  const found = arms.find((arm) => arm.includes(marker));
  assert.ok(found, `no arm containing "${marker}" found`);
  return found;
}
