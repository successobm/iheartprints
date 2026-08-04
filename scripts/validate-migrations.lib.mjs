/**
 * Pure migration filename validation helpers.
 * Pattern: YYYYMMDDHHMMSS_descriptive_name.sql (UTC timestamp prefix).
 */

export const MIGRATION_FILENAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;

/**
 * Non-.sql entries in supabase/migrations are rejected.
 * Only *.sql migration files are allowed in that directory.
 */
export function validateMigrationFilenames(filenames) {
  const errors = [];
  const sqlFiles = [];

  for (const filename of filenames) {
    if (!filename.endsWith(".sql")) {
      errors.push({
        filename,
        reason:
          "Non-SQL files are not allowed in supabase/migrations (only *.sql migration files).",
      });
      continue;
    }
    sqlFiles.push(filename);
  }

  for (const filename of sqlFiles) {
    if (filename !== filename.toLowerCase()) {
      errors.push({
        filename,
        reason: "Migration filenames must be lowercase.",
      });
      continue;
    }

    if (/\s/.test(filename)) {
      errors.push({
        filename,
        reason: "Migration filenames must not contain spaces.",
      });
      continue;
    }

    if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
      errors.push({
        filename,
        reason:
          "Filename must match ^\\d{14}_[a-z0-9_]+\\.sql$ (UTC YYYYMMDDHHMMSS_descriptive_name.sql).",
      });
    }
  }

  const validSqlFiles = sqlFiles.filter((filename) =>
    MIGRATION_FILENAME_PATTERN.test(filename),
  );

  const sorted = [...validSqlFiles].sort((a, b) => a.localeCompare(b));
  const seenTimestamps = new Map();

  for (const filename of sorted) {
    const timestamp = filename.slice(0, 14);
    if (seenTimestamps.has(timestamp)) {
      errors.push({
        filename,
        reason: `Duplicate migration timestamp ${timestamp} (also used by ${seenTimestamps.get(timestamp)}).`,
      });
    } else {
      seenTimestamps.set(timestamp, filename);
    }
  }

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const previousTs = previous.slice(0, 14);
    const currentTs = current.slice(0, 14);

    if (currentTs < previousTs) {
      errors.push({
        filename: current,
        reason: `Out-of-order timestamp relative to ${previous}. After lexical sort, timestamps must be strictly ascending.`,
      });
    }
  }

  // Explicit chronological check on the sorted list (strictly increasing).
  for (let index = 1; index < sorted.length; index += 1) {
    const previousTs = sorted[index - 1].slice(0, 14);
    const currentTs = sorted[index].slice(0, 14);
    if (currentTs <= previousTs) {
      const filename = sorted[index];
      const alreadyReported = errors.some(
        (error) =>
          error.filename === filename &&
          (error.reason.includes("Duplicate") ||
            error.reason.includes("Out-of-order")),
      );
      if (!alreadyReported) {
        errors.push({
          filename,
          reason: `Timestamp ${currentTs} is not chronologically after ${previousTs}.`,
        });
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    sortedFilenames: sorted,
  };
}

/**
 * Validates that a provided list is already in chronological lexical order
 * without sorting first. Used for focused unit tests.
 */
export function assertAlreadyChronologicallySorted(filenames) {
  const errors = [];
  for (let index = 1; index < filenames.length; index += 1) {
    const previous = filenames[index - 1];
    const current = filenames[index];
    if (current.localeCompare(previous) < 0) {
      errors.push({
        filename: current,
        reason: `Out-of-order relative to ${previous}: filenames must be in chronological lexical order.`,
      });
    }
    if (current.slice(0, 14) <= previous.slice(0, 14)) {
      errors.push({
        filename: current,
        reason: `Out-of-order timestamp ${current.slice(0, 14)} is not after ${previous.slice(0, 14)}.`,
      });
    }
  }
  return { ok: errors.length === 0, errors };
}
