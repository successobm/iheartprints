import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * Runs before `next build` (npm's implicit `prebuild` hook, see
 * package.json) and captures the exact commit the build's git checkout is
 * at, so `GET /api/version` can report the deployed commit without
 * shelling out to git at request time or assuming `.git` exists in the
 * running production container.
 *
 * Writes `GIT_SHA=<sha>` into `.env.production.local` (already git-ignored
 * by the blanket `.env*` rule in .gitignore) rather than exporting a plain
 * process environment variable — see `src/lib/config/build-info-config.ts`
 * for how that gets read, and DEPLOYMENT.md for the (currently unverified
 * against a real deploy) assumption that this file survives from
 * DigitalOcean App Platform's build phase into its run phase.
 *
 * Two failure modes this repairs (found in review of the first version):
 *
 * 1. Stale publication — a naive "only write on success" script leaves a
 *    PREVIOUS successful run's `GIT_SHA` in place if the current run fails
 *    to resolve one, silently reporting the wrong commit as if it were
 *    proven. `generateBuildInfo` strips any existing `GIT_SHA=` line
 *    FIRST, unconditionally, before attempting to resolve a new one — so a
 *    failed run can never leave a stale value behind, no matter where it
 *    fails afterward. A failure also fails the whole build (`process.exit(1)`
 *    below): shipping with no verifiable `gitSha` must be loud, not silent.
 * 2. Destructive overwrite — the previous version truncated the whole file,
 *    which would have deleted any other `.env.production.local` variable a
 *    developer or a future feature had set there. `generateBuildInfo` reads
 *    and preserves every other line verbatim, touching only the `GIT_SHA=`
 *    line.
 */
export function generateBuildInfo({ envFilePath, resolveGitSha }) {
  const existingLines = readEnvLines(envFilePath).filter(
    (line) => line.trim() !== "" && !line.startsWith("GIT_SHA="),
  );

  // Unconditional first step: drop any previous GIT_SHA. Whatever happens
  // below, a stale value can no longer be sitting in this file afterward.
  writeEnvLines(envFilePath, existingLines);

  let gitSha = null;
  try {
    gitSha = resolveGitSha();
  } catch {
    gitSha = null;
  }

  if (!gitSha || !GIT_SHA_PATTERN.test(gitSha)) {
    return { ok: false, gitSha: null };
  }

  writeEnvLines(envFilePath, [...existingLines, `GIT_SHA=${gitSha}`]);
  return { ok: true, gitSha };
}

function readEnvLines(envFilePath) {
  if (!existsSync(envFilePath)) return [];
  return readFileSync(envFilePath, "utf8").split(/\r?\n/);
}

function writeEnvLines(envFilePath, lines) {
  if (lines.length === 0) {
    if (existsSync(envFilePath)) unlinkSync(envFilePath);
    return;
  }
  writeFileSync(envFilePath, lines.join("\n") + "\n", "utf8");
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );

  const result = generateBuildInfo({
    envFilePath: path.join(repoRoot, ".env.production.local"),
    resolveGitSha: () =>
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
  });

  if (!result.ok) {
    console.error(
      "[generate-build-info] Could not determine the build's git commit " +
        "SHA (`git rev-parse HEAD` failed, or didn't return a 40-character " +
        "hex SHA). Failing the build rather than shipping with no " +
        "verifiable gitSha, or worse, a stale one left over from a " +
        "previous build.",
    );
    process.exit(1);
  }
}
