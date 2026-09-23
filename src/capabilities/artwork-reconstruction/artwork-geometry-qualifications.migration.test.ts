import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Phase R6A (Geometry-Qualified Clean Master v1): deterministic, offline
 * assertions about the SQL intent of
 * `supabase/migrations/20260922130000_artwork_geometry_qualifications.sql`
 * — mirrors `artwork-reconstruction-jobs.migration.test.ts`'s own stated
 * philosophy exactly: inspect migration SQL text so the guarantee runs on
 * every machine with zero infrastructure. Does NOT and cannot prove
 * PostgreSQL actually enforces these at runtime (no live Postgres/Supabase
 * driver exists in this repo).
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const MIGRATION_FILE = "20260922130000_artwork_geometry_qualifications.sql";

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

describe("artwork_geometry_qualifications migration", () => {
  it("creates the table", () => {
    assert.match(
      migrationSql,
      /create table if not exists public\.artwork_geometry_qualifications/,
    );
  });

  it("scopes to exactly one row per reconstruction job via a unique index", () => {
    assert.match(
      migrationSql,
      /create unique index if not exists artwork_geometry_qualifications_job_uidx\s*\n\s*on public\.artwork_geometry_qualifications \(reconstruction_job_id\)/,
    );
  });

  it("uses ON DELETE RESTRICT for every lineage foreign key, never SET NULL/CASCADE", () => {
    for (const fk of [
      "reconstruction_job_id uuid not null references public.artwork_reconstruction_jobs (id) on delete restrict",
      "candidate_asset_id uuid not null references public.assets (id) on delete restrict",
      "fidelity_contract_id uuid not null references public.artwork_fidelity_contracts (id) on delete restrict",
      "derived_asset_id uuid null references public.assets (id) on delete restrict",
    ]) {
      assert.match(migrationSql, new RegExp(fk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  it("cascades on project deletion, mirroring every sibling table", () => {
    assert.match(
      migrationSql,
      /project_id uuid not null references public\.print_projects \(id\) on delete cascade/,
    );
  });

  it("constrains qualification_status to the closed four-state set", () => {
    assert.match(
      migrationSql,
      /qualification_status in \('normalized_pending_confirmation', 'confirmed', 'rejected', 'unusable'\)/,
    );
  });

  it("constrains confirmed_by to the closed customer/operator actor set", () => {
    assert.match(
      migrationSql,
      /confirmed_by is null or confirmed_by in \('customer', 'operator'\)/,
    );
  });

  it("declares the status-consistency CHECK exactly once", () => {
    const occurrences = (
      migrationSql.match(
        /constraint artwork_geometry_qualifications_status_consistent check/g,
      ) ?? []
    ).length;
    assert.equal(occurrences, 1);
  });

  it("the status-consistency CHECK requires a derivative + geometry evidence for every non-unusable status", () => {
    const checkStart = migrationSql.indexOf(
      "constraint artwork_geometry_qualifications_status_consistent check",
    );
    assert.ok(checkStart >= 0, "status-consistency CHECK not found");
    const body = migrationSql.slice(checkStart, checkStart + 1400);
    assert.match(body, /derived_asset_id is not null/);
    assert.match(body, /content_bounds is not null/);
    assert.match(body, /normalized_width_px is not null/);
    assert.match(body, /normalized_height_px is not null/);
    assert.match(body, /content_aspect_ratio is not null/);
    assert.match(body, /detected_background_color is not null/);
  });

  it("the status-consistency CHECK requires confirmed_at/confirmed_by together only for 'confirmed', null otherwise", () => {
    const checkStart = migrationSql.indexOf(
      "constraint artwork_geometry_qualifications_status_consistent check",
    );
    const body = migrationSql.slice(checkStart, checkStart + 1400);
    assert.match(
      body,
      /qualification_status = 'confirmed' and confirmed_at is not null and confirmed_by is not null/,
    );
    assert.match(
      body,
      /qualification_status <> 'confirmed' and confirmed_at is null and confirmed_by is null/,
    );
  });

  it("the status-consistency CHECK requires 'unusable' to have NO derivative and NO geometry evidence at all", () => {
    const checkStart = migrationSql.indexOf(
      "constraint artwork_geometry_qualifications_status_consistent check",
    );
    const body = migrationSql.slice(checkStart, checkStart + 1400);
    const unusableBranchStart = body.indexOf("qualification_status = 'unusable'");
    assert.ok(unusableBranchStart >= 0, "'unusable' branch not found in CHECK");
    const unusableBranch = body.slice(unusableBranchStart, unusableBranchStart + 500);
    assert.match(unusableBranch, /derived_asset_id is null/);
    assert.match(unusableBranch, /content_bounds is null/);
    assert.match(unusableBranch, /normalized_width_px is null/);
    assert.match(unusableBranch, /normalized_height_px is null/);
    assert.match(unusableBranch, /content_aspect_ratio is null/);
    assert.match(unusableBranch, /detected_background_color is null/);
    assert.match(unusableBranch, /confirmed_at is null/);
    assert.match(unusableBranch, /confirmed_by is null/);
  });

  it("enables row level security and revokes anon/authenticated (server-only lockdown)", () => {
    assert.match(
      migrationSql,
      /alter table public\.artwork_geometry_qualifications enable row level security/,
    );
    assert.match(
      migrationSql,
      /revoke all privileges on table public\.artwork_geometry_qualifications from anon, authenticated/,
    );
  });
});
