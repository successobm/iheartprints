import { decideLocalGenerationTrigger } from "@/lib/config/local-generation-trigger-policy";
import { getWorkerSecret } from "@/lib/config/worker-config";

/**
 * Bounded FinalArtwork Production-Execution Repair: the production-safe
 * counterpart to `local-final-artwork-trigger.ts`'s interactive-`next dev`
 * in-process kick.
 *
 * Interactive `next dev` already gets a prompt worker wake via the
 * in-process scheduler call (`maybeTriggerLocalFinalArtworkWorker`) — this
 * module exists for the one environment that trigger deliberately never
 * runs in: production, where a queued `FinalArtworkJob` previously had no
 * prompt consumer at all and depended entirely on the best-effort
 * `.github/workflows/final-artwork-worker.yml` cron (observed running hours
 * apart, not every five minutes, per GitHub's own documented best-effort
 * scheduling).
 *
 * This is a LATENCY OPTIMIZATION, never a correctness dependency (per the
 * approved repair contract's own safety invariant): a genuine authenticated
 * HTTP POST to the ALREADY-BUILT, already-secured `POST /api/worker/final-
 * artwork` route, bounded by its own short timeout, with every failure mode
 * (network error, timeout, non-2xx, missing secret) swallowed and logged —
 * never thrown back to the caller. The durable `FinalArtworkJob` row and the
 * GitHub Actions recovery scheduler remain the sole correctness authority;
 * this call either helps the customer start sooner, or does nothing.
 *
 * Deliberately NOT an in-process call into `FinalArtworkSchedulerCapability`
 * (that would be exactly the "detached Promise after the response" shape
 * this repair's own architecture audit found production-unsafe on
 * DigitalOcean/Next request lifecycles) — a real, separate HTTP request,
 * authenticated the same way the GitHub Actions cron already is, hitting a
 * route whose OWN execution is now bounded (see
 * `topaz-transparency-upscale-provider.ts`'s `produceBounded`), so awaiting
 * it briefly here is safe and fast rather than reintroducing a multi-minute
 * hold.
 *
 * Loopback by default (`http://127.0.0.1:$PORT`): the same container the web
 * process is already running in, so this never depends on the public
 * DigitalOcean URL, DNS, or the platform's own gateway — exactly the layer
 * whose timeout behavior this repair could not verify from the repository.
 * Overridable via `FINAL_ARTWORK_WAKE_URL` for any deployment topology where
 * loopback is not reachable.
 *
 * Aborting THIS SIDE's fetch on timeout only stops us from waiting on the
 * response — it does not, and is not intended to, cancel the server-side
 * `runBatch()` the route kicked off; that batch keeps running to whatever
 * conclusion it reaches on its own. This call's only job is to get the
 * route invoked promptly, not to observe or control its outcome.
 */

/**
 * Repair cycle 1 (independent review follow-up): short enough that this
 * best-effort call never meaningfully delays the customer-facing enqueue
 * request it's attached to. This only needs to bound how long we wait for
 * the route to ACCEPT the request, not to observe its outcome — the route's
 * own execution is bounded (see `produceBounded`), but a full batch (up to
 * `MAX_GENERATION_JOBS_PER_RUN` jobs, each a real Topaz submit/check/
 * upload) can still take longer than is reasonable to hold a customer
 * request open for.
 */
const DEFAULT_WAKE_TIMEOUT_MS = 1_500;
const DEFAULT_LOOPBACK_PORT = "3000";

export interface WakeFinalArtworkWorkerOptions {
  /** Which enqueue path triggered this wake — logged only, never customer-facing. */
  reason: string;
  /**
   * Test-only policy override. When omitted, live `NODE_ENV` +
   * `IHEARTPRINTS_AUTOMATED_TEST` decide, exactly like
   * `local-final-artwork-trigger.ts`'s own `policy` override.
   */
  policy?: ReturnType<typeof decideLocalGenerationTrigger>;
  /** Test-only injected fetch, mirroring `TopazTransparencyUpscaleProviderConfig.fetchImpl`. */
  fetchImpl?: typeof fetch;
  /** Test-only timeout override. */
  timeoutMs?: number;
}

function resolveWakeUrl(): string {
  const override = process.env.FINAL_ARTWORK_WAKE_URL?.trim();
  if (override) return override;
  const port = process.env.PORT?.trim() || DEFAULT_LOOPBACK_PORT;
  return `http://127.0.0.1:${port}/api/worker/final-artwork`;
}

/**
 * Best-effort authenticated wake of the final-artwork worker route.
 * Never throws — every failure is logged and swallowed. Never called during
 * interactive `next dev` (the in-process trigger already covers it) or
 * automated tests (which must stay isolated from any network call).
 */
export async function wakeFinalArtworkWorker(
  options: WakeFinalArtworkWorkerOptions,
): Promise<void> {
  const decision = options.policy ?? decideLocalGenerationTrigger();
  // `allowed: true` means interactive `next dev` — the in-process trigger
  // already handles this. `reason: "automated_test"` means tests, which
  // must never make a real network call. Only `reason: "production"` wakes.
  if (decision.allowed || decision.reason !== "production") return;

  const secret = getWorkerSecret();
  if (!secret) {
    // Nothing to authenticate with. Not thrown — GitHub Actions recovery
    // remains the correctness path either way, and the route itself would
    // also refuse an unauthenticated call.
    console.error(
      `[final-artwork-wake] WORKER_SECRET is not configured; skipping wake (${options.reason})`,
    );
    return;
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(resolveWakeUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      console.error(
        `[final-artwork-wake] wake returned HTTP ${response.status} (${options.reason})`,
      );
    }
  } catch (error) {
    // Best-effort only — a network error, timeout, or abort here must never
    // fail the customer's enqueue request. The durable job and the
    // recovery scheduler are what actually guarantee correctness.
    console.error(`[final-artwork-wake] best-effort wake failed (${options.reason})`, error);
  } finally {
    clearTimeout(timeout);
  }
}
