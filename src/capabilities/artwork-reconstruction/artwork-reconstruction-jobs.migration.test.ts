import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase R5-R (independent-review repair): deterministic, offline assertions
 * about the SQL intent of
 * `supabase/migrations/20260911100000_artwork_reconstruction_jobs.sql`'s
 * repair additions — mirrors `artwork-fidelity-contracts.migration.test.ts`'s
 * own stated philosophy exactly: inspect migration SQL text so the
 * guarantee runs on every machine with zero infrastructure, on every
 * `npm run verify`. Does NOT and cannot prove PostgreSQL actually enforces
 * these at runtime (no live Postgres/Supabase driver exists in this repo).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const MIGRATION_FILE = "20260911100000_artwork_reconstruction_jobs.sql";

function sqlWithoutComments(sql: string): string {
  return sql
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();
}

const migrationSql = sqlWithoutComments(
  readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_FILE), "utf8"),
);

describe("artwork_reconstruction_jobs migration — Blocker/finding repairs", () => {
  it("candidate_asset_id uses ON DELETE RESTRICT, never SET NULL (a completed job's candidate must never be deletable out from under it)", () => {
    assert.match(
      migrationSql,
      /candidate_asset_id uuid null references public\.assets \(id\) on delete restrict/,
    );
    assert.ok(
      !/candidate_asset_id[^,]*on delete set null/.test(migrationSql),
      "candidate_asset_id must not use ON DELETE SET NULL — it conflicts with the completion-consistency CHECK",
    );
  });

  it("declares the three protected-mark-review columns", () => {
    assert.match(migrationSql, /protected_marks_reviewed boolean null/);
    assert.match(migrationSql, /protected_marks_reviewed_at timestamptz null/);
    assert.match(migrationSql, /protected_marks_reviewed_by text null/);
  });

  it("protected_marks_reviewed_by is constrained to the closed customer/operator actor set", () => {
    assert.match(
      migrationSql,
      /protected_marks_reviewed_by is null or protected_marks_reviewed_by in \('customer', 'operator'\)/,
    );
  });

  it("declares the mark-review consistency CHECK exactly once", () => {
    const occurrences = (
      migrationSql.match(/constraint artwork_reconstruction_jobs_mark_review_consistent check/g) ??
      []
    ).length;
    assert.equal(occurrences, 1);
  });

  it("the mark-review CHECK requires all three columns null together, or all three set together — never a partial attestation", () => {
    const checkStart = migrationSql.indexOf(
      "constraint artwork_reconstruction_jobs_mark_review_consistent check",
    );
    assert.ok(checkStart >= 0, "mark-review CHECK constraint not found");
    const body = migrationSql.slice(checkStart, checkStart + 700);
    assert.match(body, /protected_marks_reviewed is null/);
    assert.match(body, /protected_marks_reviewed_at is null/);
    assert.match(body, /protected_marks_reviewed_by is null/);
    assert.match(body, /protected_marks_reviewed is not null/);
    assert.match(body, /protected_marks_reviewed_at is not null/);
    assert.match(body, /protected_marks_reviewed_by is not null/);
  });

  it("declares the paid-duplicate-request partial unique index, scoped to (project, source, contractKey)", () => {
    assert.match(
      migrationSql,
      /create unique index if not exists artwork_reconstruction_jobs_active_binding_uidx\s*\n\s*on public\.artwork_reconstruction_jobs \(project_id, source_asset_id, contract_key\)/,
    );
  });

  it("the active-binding index excludes failed/cancelled AND rejected rows -- a dead attempt or an explicit rejection must free the slot for a fresh 'Try again'", () => {
    const idxStart = migrationSql.indexOf("artwork_reconstruction_jobs_active_binding_uidx");
    assert.ok(idxStart >= 0);
    const body = migrationSql.slice(idxStart, idxStart + 400);
    assert.match(body, /status not in \('failed', 'cancelled'\)/);
    assert.match(body, /review_status is null or review_status <> 'rejected'/);
  });

  it("the completion-consistency CHECK from the original R5 slice is unweakened by this repair", () => {
    assert.match(migrationSql, /constraint artwork_reconstruction_jobs_completion_consistent check/);
  });
});
