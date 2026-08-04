import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateMigrationFilenames } from "./validate-migrations.lib.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_MIGRATIONS_DIR = path.join(
  __dirname,
  "..",
  "supabase",
  "migrations",
);

export async function validateMigrationsDirectory(
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
) {
  let entries;
  try {
    entries = await readdir(migrationsDir, { withFileTypes: true });
  } catch (error) {
    const err = error;
    if (err && err.code === "ENOENT") {
      return {
        ok: false,
        errors: [
          {
            filename: migrationsDir,
            reason: "Migrations directory does not exist.",
          },
        ],
        sortedFilenames: [],
        migrationsDir,
      };
    }
    throw error;
  }

  const filenames = [];
  const errors = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      filenames.push(entry.name);
      continue;
    }

    errors.push({
      filename: entry.name,
      reason:
        "Only flat *.sql migration files are allowed in supabase/migrations (directories are rejected).",
    });
  }

  const result = validateMigrationFilenames(filenames);
  const mergedErrors = [...errors, ...result.errors];
  return {
    ok: mergedErrors.length === 0,
    errors: mergedErrors,
    sortedFilenames: result.sortedFilenames,
    migrationsDir,
  };
}

function printReport(result) {
  const relativeDir = path.relative(process.cwd(), result.migrationsDir) || ".";
  console.log(`Validating migrations in ${relativeDir}`);

  if (result.sortedFilenames.length === 0 && result.ok) {
    console.log("No migration files found.");
  } else if (result.sortedFilenames.length > 0) {
    console.log("Migration order:");
    for (const filename of result.sortedFilenames) {
      console.log(`  - ${filename}`);
    }
  }

  if (result.ok) {
    console.log("Migration filename validation passed.");
    return;
  }

  console.error("Migration filename validation failed:");
  for (const error of result.errors) {
    console.error(`  - ${error.filename}: ${error.reason}`);
  }
}

async function main() {
  const result = await validateMigrationsDirectory();
  printReport(result);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  await main();
}
