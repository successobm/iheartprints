import { NextResponse } from "next/server";

import {
  getBuildGitSha,
  getRuntimeEnvironment,
} from "@/lib/config/build-info-config";

/**
 * Read-only deployment-identity check. No DB, no provider, no auth — the
 * same public/no-secrets surface as any health endpoint. Exists so a
 * rollout can verify `gitSha` against the expected merge SHA instead of
 * inferring a deploy from CDN Age headers, chunk hashes, or timing (see
 * DEPLOYMENT.md's release verification procedure).
 *
 * Fails closed: a build that couldn't determine its own commit (see
 * `getBuildGitSha`) returns `503` with `gitSha: null`, never a fabricated
 * placeholder that would make an unproven deployment look verified.
 */
export async function GET() {
  const gitSha = getBuildGitSha();
  const environment = getRuntimeEnvironment();

  if (!gitSha) {
    return NextResponse.json(
      { ok: false, gitSha: null, environment },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    { ok: true, gitSha, environment },
    { headers: { "cache-control": "no-store" } },
  );
}
