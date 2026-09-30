import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Runs before `next build` (npm's implicit `prebuild` hook, see
 * package.json) and captures the exact commit the build's git checkout is
 * at, so `GET /api/version` can report the deployed commit without
 * shelling out to git at request time or assuming `.git` exists in the
 * running production container.
 *
 * Writes `.env.production.local` (already git-ignored by the blanket
 * `.env*` rule in .gitignore) rather than exporting a plain process
 * environment variable. DigitalOcean App Platform's buildpack build and
 * run phases share the app directory's filesystem, but not this script's
 * own process environment — a file that Next.js's own env loader reads at
 * `next start` survives that boundary; a variable set only in this
 * script's process does not. See `src/lib/config/build-info-config.ts`.
 *
 * Never throws and never fabricates: if git is unavailable, this isn't a
 * git checkout, or HEAD doesn't resolve to a full 40-character SHA, it
 * silently leaves `GIT_SHA` unset rather than writing a placeholder. A
 * missing `GIT_SHA` is what makes `GET /api/version` fail closed.
 */
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

let gitSha = null;
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
} catch {
  gitSha = null;
}

if (gitSha && /^[0-9a-f]{40}$/.test(gitSha)) {
  writeFileSync(
    path.join(repoRoot, ".env.production.local"),
    `GIT_SHA=${gitSha}\n`,
    "utf8",
  );
}
