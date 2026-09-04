"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SignMachineReadableContentSummary } from "@/capabilities/sign-preparation";

/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION.
 *
 * A QR code is machine-readable semantic content, not an ordinary
 * decorative region — visual similarity between a source QR and a
 * reconstructed one is never equivalent to functional equivalence. This
 * panel makes that problem understandable to the operator (Section W) and
 * exposes exactly two governed actions, both mirroring the SAME
 * fetch → `router.refresh()` pattern every other operator action on this
 * page already uses:
 *
 *   "Check QR code"    — read-only to the artwork. Always available once a
 *                         production candidate exists. Decodes the source
 *                         and the current candidate, compares, and
 *                         persists the result (`.../sign-artwork/qr-check`).
 *
 *   "Restore QR code"  — only rendered when the last check found a
 *                         PROVEN regression (a source QR that decoded, but
 *                         the candidate lost or changed it). Never
 *                         reachable for a source that could not itself be
 *                         verified — there is no verified payload to
 *                         restore FROM (Section I).
 *
 * No raw internal vocabulary (`machine_readable_content_preserved`,
 * `planKey`, payload hashes) ever reaches this component's rendered copy.
 */
export function SignQrPreservationPanel({
  projectId,
  machineReadableContent,
}: {
  projectId: string;
  machineReadableContent: SignMachineReadableContentSummary | null;
}) {
  const router = useRouter();
  const [checking, setChecking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runAction(path: "qr-check" | "qr-restore", setBusy: (v: boolean) => void) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/${path}`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      router.refresh();
      setBusy(false);
    } catch {
      setError("That didn't work. Please try again.");
      setBusy(false);
    }
  }

  const overall = machineReadableContent?.overall ?? null;
  const regionCount = machineReadableContent?.regions.length ?? 0;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-ink/10 p-3" data-sign-qr-preservation-panel>
      <h3 className="text-sm font-semibold text-ink">QR code</h3>

      {overall === null ? (
        <p className="text-sm text-muted" data-sign-qr-status="not_checked">
          Not checked yet for this candidate.
        </p>
      ) : overall === "not_applicable" ? (
        <p className="text-sm text-muted" data-sign-qr-status="not_applicable">
          No QR code was found in this artwork.
        </p>
      ) : overall === "pass" ? (
        <p className="text-sm text-ink" data-sign-qr-status="pass">
          Verified — destination preserved{regionCount > 1 ? ` (${regionCount} codes)` : ""}.
        </p>
      ) : overall === "review_required" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink" data-sign-qr-status="review_required">
            We found a QR code, but we couldn&apos;t verify its destination from the original artwork.
          </p>
          <p className="text-xs text-muted">Confirm the QR destination before replacing it.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink" data-sign-qr-status={overall}>
            Original: Verified — Prepared artwork:{" "}
            {overall === "fail" ? "Could not be read" : "Decodes a different destination"}
          </p>
          <p className="text-xs text-muted">
            iHeartPrints verified the QR destination from the original artwork and can restore a clean, scannable QR
            without changing its destination.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void runAction("qr-check", setChecking)}
          disabled={checking || restoring}
          aria-busy={checking}
          className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-qr-check-button"
        >
          {checking ? "Checking…" : "Check QR code"}
        </button>
        {overall === "fail" || overall === "hard_fail" ? (
          <button
            type="button"
            onClick={() => void runAction("qr-restore", setRestoring)}
            disabled={checking || restoring}
            aria-busy={restoring}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-qr-restore-button"
          >
            {restoring ? "Restoring…" : "Restore QR code"}
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-qr-preservation-error>
          {error}
        </p>
      ) : null}
    </section>
  );
}
