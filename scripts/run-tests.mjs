import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { TEST_FILES } from "./test-files.mjs";

/**
 * Runs the registered test suite.
 *
 * Exists only to keep the (long) file list off the shell command line — see
 * `test-files.mjs`. Behavior is otherwise identical to the previous inline
 * `node --import tsx --import ./src/test-support/test-safety-bootstrap.ts
 * --test <files>` invocation, including the order files are passed in and,
 * critically, the `test-safety-bootstrap` preload that guarantees every test
 * process carries `IHEARTPRINTS_AUTOMATED_TEST=1` before any test file loads.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    "./src/test-support/test-safety-bootstrap.ts",
    "--test",
    ...TEST_FILES,
  ],
  { cwd: repoRoot, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
