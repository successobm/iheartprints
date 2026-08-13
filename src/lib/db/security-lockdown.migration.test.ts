import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Server-Only RLS Lockdown: deterministic, offline assertions about the
 * SECURITY INTENT encoded in `supabase/migrations`.
 *
 * These tests deliberately inspect migration SQL rather than a live
 * database. A test that needs credentials is a test that gets skipped in CI
 * and stops protecting anything; this one runs on every `npm run verify`,
 * on every machine, with no infrastructure at all.
 *
 * The live database is verified separately and by different means: the
 * lockdown migration asserts its own postconditions against `pg_class`,
 * `pg_policies`, and `information_schema.role_table_grants` and aborts if
 * they do not hold, and an anonymous PostgREST probe proves denial
 * behaviorally from outside.
 *
 * The most important test in this file is the LAST one. The first six prove
 * we closed the twelve tables we already knew about; `every application
 * table created by any migration is locked down` is the one that prevents
 * table #13 from repeating the incident.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const LOCKDOWN_MIGRATION = "20260811191500_server_only_rls_lockdown.sql";

/**
 * The twelve tables the security audit found exposed. Hardcoded rather than
 * derived, so that a migration silently dropping a table from the lockdown
 * is a test failure instead of a quietly smaller expectation.
 */
const APPLICATION_TABLES = [
  "print_projects",
  "tshirt_design_briefs",
  "design_conversations",
  "conversation_messages",
  "artwork_versions",
  "design_brief_versions",
  "generation_jobs",
  "assets",
  "final_direction_approvals",
  "final_artwork_jobs",
  "production_asset_validations",
  "artwork_preparations",
] as const;

function migrationFilenames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/**
 * Strips `--` line comments so prose about SQL is never mistaken for SQL.
 * Normalizes CRLF/CR to LF first so `$` and `.` behave the same on Windows
 * checkouts as on LF-only trees (JS `.` does not match `\r`).
 */
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

const lockdownSql = readSqlWithoutComments(LOCKDOWN_MIGRATION);
const allMigrationsSql = migrationFilenames()
  .map((name) => readSqlWithoutComments(name))
  .join("\n");

function enablesRls(sql: string, table: string): boolean {
  return new RegExp(
    `alter\\s+table\\s+(?:if\\s+exists\\s+)?public\\.${table}\\s+enable\\s+row\\s+level\\s+security`,
  ).test(sql);
}

function revokesFrom(sql: string, table: string, role: string): boolean {
  // Matches `revoke all privileges on table public.<t> from anon, authenticated;`
  // and any ordering/subset of that role list.
  const pattern = new RegExp(
    `revoke\\s+all(?:\\s+privileges)?\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+([^;]+);`,
  );
  const match = sql.match(pattern);
  if (!match) return false;
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .includes(role);
}

describe("sqlWithoutComments CRLF hygiene", () => {
  it("A: strips LF SQL line comments", () => {
    const out = sqlWithoutComments(
      "-- owner_user_id comment\nSELECT 1;\n",
    );
    assert.equal(out.includes("owner_user_id"), false);
    assert.match(out, /select\s+1/);
  });

  it("B: strips CRLF SQL line comments", () => {
    const out = sqlWithoutComments(
      "-- owner_user_id comment\r\nSELECT 1;\r\n",
    );
    assert.equal(out.includes("owner_user_id"), false);
    assert.match(out, /select\s+1/);
  });

  it("C: preserves executable owner_user_id", () => {
    const out = sqlWithoutComments(
      "-- prose only\r\nalter table t add column owner_user_id uuid;\r\n",
    );
    assert.match(out, /add\s+column\s+owner_user_id/);
  });

  it("D: preserves executable tenant_id", () => {
    const out = sqlWithoutComments(
      "-- prose only\nalter table t add column tenant_id uuid;\n",
    );
    assert.match(out, /add\s+column\s+tenant_id/);
  });

  it("E: comment-only identity words do not survive stripping", () => {
    const out = sqlWithoutComments(
      [
        "-- model yet: no `owner_user_id`, `tenant_id`, or `organization_id`",
        "--   * An invented `owner_user_id` column",
        "alter table public.print_projects enable row level security;",
      ].join("\r\n"),
    );
    for (const column of ["owner_user_id", "tenant_id", "organization_id"]) {
      assert.equal(
        out.includes(column),
        false,
        `comment-only ${column} must not remain after stripping`,
      );
    }
    assert.match(out, /enable\s+row\s+level\s+security/);
  });
});

describe("server-only RLS lockdown migration", () => {
  it("exists in the migrations directory", () => {
    assert.ok(
      migrationFilenames().includes(LOCKDOWN_MIGRATION),
      `${LOCKDOWN_MIGRATION} is missing`,
    );
  });

  /**
   * Phase 2C0.5: this used to assert the lockdown was literally the LAST
   * migration in the directory. That was a proxy for the real rule, and it
   * only held while no table had been added since — the first additive
   * migration after the lockdown (`paid_image_intents`) breaks the proxy
   * without weakening the security posture by one bit.
   *
   * The rule the name actually states is asserted directly instead: every
   * table the lockdown is responsible for must be CREATED by a migration
   * that sorts before it, so the lockdown can never run against a table
   * that does not exist yet. Tables introduced AFTER the lockdown are
   * governed by the convention test at the bottom of this file, which
   * requires each one to enable RLS and revoke `anon`/`authenticated` in
   * its own migration — a stronger guarantee than "nothing may ever be
   * added again", and one that does not silently expire.
   */
  it("is ordered after every table it locks down, so it can never run against a table that does not exist yet", () => {
    const names = migrationFilenames();
    const lockdownIndex = names.indexOf(LOCKDOWN_MIGRATION);
    assert.ok(lockdownIndex >= 0, `${LOCKDOWN_MIGRATION} is missing`);

    const earlierSql = names
      .slice(0, lockdownIndex)
      .map((name) => readSqlWithoutComments(name))
      .join("\n");

    for (const table of APPLICATION_TABLES) {
      assert.ok(
        new RegExp(
          `create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?public\\.${table}\\b`,
        ).test(earlierSql),
        `${table} is locked down but is not created by any earlier migration`,
      );
    }
  });

  // A
  it("covers all twelve audited application tables", () => {
    for (const table of APPLICATION_TABLES) {
      assert.ok(
        lockdownSql.includes(`public.${table}`),
        `${table} is not mentioned in the lockdown migration`,
      );
    }
  });

  // B
  it("enables row level security on every application table", () => {
    for (const table of APPLICATION_TABLES) {
      assert.ok(
        enablesRls(lockdownSql, table),
        `${table} has no ENABLE ROW LEVEL SECURITY statement`,
      );
    }
  });

  // E
  it("revokes anon table privileges on every application table", () => {
    for (const table of APPLICATION_TABLES) {
      assert.ok(
        revokesFrom(lockdownSql, table, "anon"),
        `${table} does not revoke privileges from anon`,
      );
    }
  });

  // F
  it("revokes authenticated table privileges on every application table", () => {
    for (const table of APPLICATION_TABLES) {
      assert.ok(
        revokesFrom(lockdownSql, table, "authenticated"),
        `${table} does not revoke privileges from authenticated`,
      );
    }
  });

  it("never revokes anything from service_role, which the server depends on", () => {
    const revokes = lockdownSql.match(/revoke[^;]+;/g) ?? [];
    for (const statement of revokes) {
      assert.ok(
        !/\bservice_role\b/.test(statement),
        `lockdown migration revokes from service_role: ${statement.trim()}`,
      );
    }
  });

  it("does not touch Supabase-managed schemas", () => {
    for (const schema of ["auth.", "storage.", "realtime.", "vault."]) {
      assert.ok(
        !lockdownSql.includes(schema),
        `lockdown migration references managed schema ${schema}`,
      );
    }
  });
});

describe("no permissive browser-facing policy exists anywhere", () => {
  const createPolicyStatements = allMigrationsSql.match(/create\s+policy[^;]+;/g) ?? [];

  // C + D
  it("no migration creates a policy for anon or authenticated", () => {
    for (const statement of createPolicyStatements) {
      for (const role of ["anon", "authenticated"]) {
        assert.ok(
          !new RegExp(`\\bto\\b[^;]*\\b${role}\\b`).test(statement),
          `a policy grants ${role} access: ${statement.trim()}`,
        );
      }
    }
  });

  it("no migration creates an unconditional using (true) policy", () => {
    for (const statement of createPolicyStatements) {
      assert.ok(
        !/using\s*\(\s*true\s*\)/.test(statement),
        `a policy is unconditionally permissive: ${statement.trim()}`,
      );
    }
  });

  it("no migration grants application table privileges to anon or authenticated", () => {
    const grants = allMigrationsSql.match(/\bgrant\s+[^;]+;/g) ?? [];
    for (const statement of grants) {
      for (const role of ["anon", "authenticated"]) {
        assert.ok(
          !new RegExp(`\\bto\\b[^;]*\\b${role}\\b`).test(statement),
          `a migration grants ${role} privileges: ${statement.trim()}`,
        );
      }
    }
  });

  it("invents no ownership column, because no customer identity model exists yet", () => {
    for (const column of ["owner_user_id", "tenant_id", "organization_id"]) {
      assert.ok(
        !allMigrationsSql.includes(column),
        `migrations reference ${column}, but there is no customer identity model`,
      );
    }
  });
});

/**
 * I — the convention test. This is what stops the incident from recurring.
 */
describe("new public application tables must be locked down", () => {
  function createdTables(sql: string): string[] {
    const matches = sql.matchAll(
      /create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z0-9_]+)/g,
    );
    return [...matches].map((match) => match[1]);
  }

  it("finds every audited table declared in the migration history", () => {
    const created = new Set(createdTables(allMigrationsSql));
    for (const table of APPLICATION_TABLES) {
      assert.ok(created.has(table), `${table} is never created by a migration`);
    }
  });

  it("every application table created by any migration is locked down", () => {
    const created = [...new Set(createdTables(allMigrationsSql))];

    const unprotected = created.filter(
      (table) =>
        !enablesRls(allMigrationsSql, table) ||
        !revokesFrom(allMigrationsSql, table, "anon") ||
        !revokesFrom(allMigrationsSql, table, "authenticated"),
    );

    assert.deepEqual(
      unprotected,
      [],
      `New public table(s) without server-only security treatment: ${unprotected.join(", ")}. ` +
        "Every public application table must ENABLE ROW LEVEL SECURITY and REVOKE ALL " +
        "PRIVILEGES FROM anon, authenticated in the same migration that creates it. " +
        "See supabase/migrations/" +
        LOCKDOWN_MIGRATION +
        " and ARCHITECTURE.md (Current Data Access Model).",
    );
  });
});
