import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertAlreadyChronologicallySorted,
  MIGRATION_FILENAME_PATTERN,
  validateMigrationFilenames,
} from "./validate-migrations.lib.mjs";

describe("migration filename pattern", () => {
  it("accepts valid UTC timestamp filenames", () => {
    assert.equal(
      MIGRATION_FILENAME_PATTERN.test("20260804130000_sprint1_conversation.sql"),
      true,
    );
    assert.equal(
      MIGRATION_FILENAME_PATTERN.test("20260804130100_add_print_projects_rls.sql"),
      true,
    );
  });
});

describe("validateMigrationFilenames", () => {
  it("valid filenames pass", () => {
    const result = validateMigrationFilenames([
      "20260804130100_add_print_projects_rls.sql",
      "20260804130000_sprint1_conversation.sql",
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.sortedFilenames, [
      "20260804130000_sprint1_conversation.sql",
      "20260804130100_add_print_projects_rls.sql",
    ]);
  });

  it("malformed filename fails", () => {
    const result = validateMigrationFilenames(["20260324_sprint1_conversation.sql"]);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].reason, /must match/);
  });

  it("duplicate timestamp fails", () => {
    const result = validateMigrationFilenames([
      "20260804130000_first.sql",
      "20260804130000_second.sql",
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.reason.includes("Duplicate migration timestamp")),
    );
  });

  it("out-of-order timestamps fail", () => {
    const result = assertAlreadyChronologicallySorted([
      "20260804130100_later.sql",
      "20260804130000_earlier.sql",
    ]);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.reason.includes("Out-of-order")));
  });

  it("uppercase fails", () => {
    const result = validateMigrationFilenames([
      "20260804130000_Sprint1_Conversation.sql",
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.reason.includes("lowercase") || error.reason.includes("must match"),
      ),
    );
  });

  it("spaces fail", () => {
    const result = validateMigrationFilenames([
      "20260804130000_sprint 1 conversation.sql",
    ]);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some(
        (error) =>
          error.reason.includes("spaces") || error.reason.includes("must match"),
      ),
    );
  });

  it("non-SQL files fail with a documented rule", () => {
    const result = validateMigrationFilenames([
      "20260804130000_ok.sql",
      "readme.md",
      "notes.txt",
    ]);
    assert.equal(result.ok, false);
    const nonSqlErrors = result.errors.filter((error) =>
      error.reason.includes("Non-SQL files are not allowed"),
    );
    assert.equal(nonSqlErrors.length, 2);
  });

  it("date-only prefix fails", () => {
    const result = validateMigrationFilenames(["20260804_missing_time.sql"]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].reason, /must match/);
  });
});
