import { NextResponse } from "next/server";

/**
 * TEMPORARY DIAGNOSTIC — REMOVE AFTER DIGITALOCEAN REQUEST-LIFETIME TEST.
 *
 * Purpose: determine empirically whether the DigitalOcean App Platform
 * request path (ingress + load balancer + `next start`) can keep an
 * ordinary public HTTP request alive long enough for the DTF Generative
 * Reconstruction provider's synchronous ~125-135s real-world call
 * durations, against its 300s code-level timeout.
 *
 * Deliberately isolated on `diagnostic/do-request-duration-test`, branched
 * from `main` — NOT the DTF reconstruction feature branch. No relationship
 * to `DtfGenerativeReconstructionCapability`/provider code, which this
 * route neither imports nor exercises.
 *
 * Safety, all enforced below:
 *   - GET only, no body accepted.
 *   - `seconds` clamped to the closed range [1, 180] — never an arbitrary
 *     caller-controlled sleep duration, never above the 180s ceiling this
 *     diagnostic is authorized for.
 *   - No external I/O of any kind: no provider call (OpenAI/Topaz), no
 *     database read/write, no filesystem write, no other network request.
 *     The only work performed is awaiting a local, in-process timer.
 *   - No environment variable, secret, or internal configuration value is
 *     read or returned.
 *   - No side effect — nothing is persisted; repeated calls are always
 *     independent and safe to retry.
 */

const MIN_SECONDS = 1;
const MAX_SECONDS = 180;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("seconds");

  // Default 160s — the exact duration this diagnostic exists to test —
  // but only when the caller omits the parameter entirely; an explicitly
  // invalid value is rejected rather than silently substituted.
  if (raw === null) {
    return await runAndRespond(160);
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return NextResponse.json(
      { ok: false, error: "seconds must be an integer" },
      { status: 400 },
    );
  }
  if (parsed < MIN_SECONDS || parsed > MAX_SECONDS) {
    return NextResponse.json(
      {
        ok: false,
        error: `seconds must be between ${MIN_SECONDS} and ${MAX_SECONDS}`,
      },
      { status: 400 },
    );
  }

  return await runAndRespond(parsed);
}

async function runAndRespond(requestedSeconds: number) {
  const startedAt = process.hrtime.bigint();
  await sleep(requestedSeconds * 1000);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  return NextResponse.json({
    ok: true,
    requestedSeconds,
    elapsedMs,
  });
}
