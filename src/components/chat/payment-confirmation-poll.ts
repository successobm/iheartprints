/**
 * Sprint A5.5: bounded polling while a payment is being confirmed.
 *
 * WHY NOT `createStatusPollController`
 *
 * That controller stops on a terminal status or on repeated errors, but it
 * has no ATTEMPT CEILING — it is driven by a status endpoint that always
 * eventually answers. Payment confirmation has no such guarantee: a customer
 * may have abandoned checkout, in which case the answer never changes and
 * polling would continue for as long as the tab is open. Widening the shared
 * controller to add a ceiling would change behaviour for generation and
 * finalization polling too, which is not this sprint's business.
 *
 * So this is its own small controller with one extra rule — stop after
 * `maxAttempts` — and it is pure and injectable so the bound is asserted by
 * a test rather than by waiting.
 *
 * WHAT TIMING OUT MEANS, and does not: the poller giving up says nothing
 * about whether the customer paid. It says we have not heard yet. The copy it
 * drives (`PAYMENT_CONFIRMATION_TIMEOUT_MESSAGE`) therefore asks the customer
 * to reload shortly and NEVER to pay again — a transaction may be `created`
 * or already `paid` at that moment, and inviting a second attempt is how
 * somebody gets charged twice for one unlock.
 */

export const DEFAULT_PAYMENT_POLL_INTERVAL_MS = 2500;

/**
 * Twenty-four attempts at 2.5s is roughly a minute of wall clock.
 *
 * Long enough that an ordinary webhook — which normally lands within seconds
 * of the redirect, and often before it — is comfortably covered, including a
 * provider retry after a transient failure. Short enough that an abandoned
 * checkout stops spinning while the customer is still looking at it.
 */
export const DEFAULT_PAYMENT_POLL_MAX_ATTEMPTS = 24;

export interface PaymentConfirmationPollOptions {
  /**
   * Re-reads AUTHORITATIVE server state. Resolves `true` once the project is
   * genuinely unlocked, which is the only thing that stops this successfully.
   *
   * Deliberately a boolean rather than a snapshot: the caller already applies
   * the fresh snapshot to its own state, and returning one here would invite
   * a second place to interpret it.
   */
  refreshAndCheckUnlocked: () => Promise<boolean>;
  /** Called once if the ceiling is reached without an answer. */
  onTimeout: () => void;
  intervalMs?: number;
  maxAttempts?: number;
  /** Injected by tests. Defaults to the real timer. */
  scheduler?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
}

export interface PaymentConfirmationPoll {
  /** Call once per effect invocation; return the result from `useEffect`. */
  start(): () => void;
}

export function createPaymentConfirmationPoll(
  options: PaymentConfirmationPollOptions,
): PaymentConfirmationPoll {
  const intervalMs = options.intervalMs ?? DEFAULT_PAYMENT_POLL_INTERVAL_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_PAYMENT_POLL_MAX_ATTEMPTS;
  const scheduler = options.scheduler ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };

  return {
    start() {
      let cancelled = false;
      let attempts = 0;
      let handle: unknown = null;

      // `setTimeout` chained per attempt rather than `setInterval`, so a slow
      // refresh can never overlap itself into a pile of concurrent requests
      // against a server that is already struggling.
      const schedule = () => {
        handle = scheduler.setTimeout(() => {
          void tick();
        }, intervalMs);
      };

      const tick = async () => {
        if (cancelled) return;
        attempts += 1;

        let unlocked = false;
        try {
          unlocked = await options.refreshAndCheckUnlocked();
        } catch {
          // A failed refresh is an ordinary transient, and it still consumes
          // an attempt — otherwise a persistently failing endpoint would poll
          // forever, which is exactly the bound this controller exists for.
          unlocked = false;
        }
        if (cancelled) return;

        // Stopping silently on success is correct: the fresh snapshot has
        // already moved the surface to `production_unlocked`, so there is
        // nothing for this controller to announce.
        if (unlocked) return;

        if (attempts >= maxAttempts) {
          options.onTimeout();
          return;
        }
        schedule();
      };

      // The first check happens immediately. A webhook that landed BEFORE the
      // browser returned is the common case, and making the customer watch a
      // spinner for one interval before discovering they are already unlocked
      // would be a self-inflicted delay.
      void tick();

      return () => {
        cancelled = true;
        if (handle !== null) scheduler.clearTimeout(handle);
      };
    },
  };
}
