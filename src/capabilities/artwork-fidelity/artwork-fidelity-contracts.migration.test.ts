import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase R3B-R (independent-review repair): deterministic, offline
 * assertions about the SQL intent of
 * `supabase/migrations/20260910120000_artwork_fidelity_contracts.sql`'s
 * status-consistency CHECK constraint — mirrors
 * `security-lockdown.migration.test.ts`'s and
 * `final-artwork-job-source-identity.migration.test.ts`'s own stated
 * philosophy: inspect migration SQL text so the guarantee runs on every
 * machine with zero infrastructure, on every `npm run verify`.
 *
 * This proves the constraint's TEXT is present and has not been weakened
 * or accidentally removed — e.g. by a future edit that adds a column
 * without updating the CHECK, or that drops the CHECK while "simplifying"
 * the migration. It does NOT and cannot prove PostgreSQL actually enforces
 * it at runtime (no live Postgres/Supabase driver exists in this repo to
 * connect to — the same limitation `final-artwork-job-source-identity
 * .migration.test.ts`'s own doc comment states).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const MIGRATION_FILE = "20260910120000_artwork_fidelity_contracts.sql";
const CONSTRAINT_NAME = "artwork_fidelity_contracts_confirmation_consistent";

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

/** Pulls the parenthesized OR-arm containing `marker` out of the CHECK constraint body. */
function extractArm(sql: string, marker: string): string {
  const checkStart = sql.indexOf(`${CONSTRAINT_NAME} check`);
  assert.ok(checkStart >= 0, "CHECK constraint not found");
  const body = sql.slice(checkStart);
  const arms = body.split(/\)\s*or\s*\(/);
  const found = arms.find((arm) => arm.includes(marker));
  assert.ok(found, `no arm containing "${marker}" found`);
  return found;
}

describe("artwork_fidelity_contracts migration — confirmation-consistency CHECK", () => {
  it("declares the constraint exactly once", () => {
    const occurrences = (
      migrationSql.match(new RegExp(`constraint\\s+${CONSTRAINT_NAME}\\s+check`, "g")) ?? []
    ).length;
    assert.equal(occurrences, 1, `expected exactly one declaration of ${CONSTRAINT_NAME}`);
  });

  it("the 'proposed' arm requires every confirmation field to be null", () => {
    const arm = extractArm(migrationSql, "status = 'proposed'");
    assert.match(arm, /confirmed_by is null/);
    assert.match(arm, /confirmed_at is null/);
    assert.match(arm, /contract_key is null/);
    assert.match(arm, /confirmed_wording is null/);
    assert.match(arm, /confirmed_marks is null/);
  });

  it("the 'confirmed' arm requires confirmed_by/confirmed_at/contract_key to be non-null", () => {
    const arm = extractArm(migrationSql, "status = 'confirmed'");
    assert.match(arm, /confirmed_by is not null/);
    assert.match(arm, /confirmed_at is not null/);
    assert.match(arm, /contract_key is not null/);
  });

  it("the confirmed arm does not weaken confirmed_wording/confirmed_marks semantics by requiring them non-null (an empty array is a valid confirmed fact, not absence)", () => {
    const arm = extractArm(migrationSql, "status = 'confirmed'");
    assert.ok(
      !/confirmed_wording is not null/.test(arm),
      "the confirmed arm must not require confirmed_wording — an empty array (already valid) round-trips through this column fine, but requiring non-null here would be enforcing the wrong invariant",
    );
    assert.ok(
      !/confirmed_marks is not null/.test(arm),
      "the confirmed arm must not require confirmed_marks — same reasoning as confirmed_wording",
    );
  });

  it("the status column itself is still constrained to exactly proposed/confirmed", () => {
    assert.match(migrationSql, /status\s+text\s+not\s+null\s+default\s+'proposed'/);
    assert.match(migrationSql, /check\s*\(\s*status\s+in\s*\(\s*'proposed'\s*,\s*'confirmed'\s*\)\s*\)/);
  });
});
