"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SignPhysicalResolutionMetadataSummary } from "@/capabilities/sign-preparation";

/**
 * Fix Existing Final Sign Candidate Physical-Resolution Metadata Repair
 * Phase (real Get Hibachi production incident): a candidate can have
 * correct artwork, geometry, and a verified QR, yet still carry a missing
 * or wrong embedded print-size density tag — production software (Corel,
 * etc.) then interprets its real pixels at an arbitrary default size
 * instead of the ordered one. This panel exposes ONE governed action:
 *
 *   "Fix print size metadata" — only rendered when the check is known to
 *                                disagree, OR has never been evaluated at
 *                                all (a validation persisted before this
 *                                check existed — the real historical Get
 *                                Hibachi shape). Never rendered once the
 *                                check reads `"pass"`.
 *
 * Rendered unconditionally alongside `SignQrPreservationPanel` whenever a
 * job has completed (see `page.tsx`) — deliberately NOT gated by the
 * overall print-ready CTA, because the real historical defect this repairs
 * is a candidate the system otherwise considers print-ready (its report
 * simply predates this check) while its actual downloaded bytes are wrong.
 *
 * No raw internal vocabulary ("pHYs", "PPI metadata", `physical_resolution
 * _metadata`) ever reaches this component's rendered copy.
 */
export function SignPhysicalResolutionRepairPanel({
  projectId,
  physicalResolutionMetadata,
}: {
  projectId: string;
  physicalResolutionMetadata: SignPhysicalResolutionMetadataSummary | null;
}) {
  const router = useRouter();
  const [repairing, setRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRepair() {
    if (repairing) return;
    setRepairing(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/physical-resolution-repair`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "That didn't work. Please try again.");
        setRepairing(false);
        return;
      }
      router.refresh();
      setRepairing(false);
    } catch {
      setError("That didn't work. Please try again.");
      setRepairing(false);
    }
  }

  const status = physicalResolutionMetadata?.status ?? null;
  const needsFix = status !== "pass";

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-ink/10 p-3" data-sign-physical-resolution-panel>
      <h3 className="text-sm font-semibold text-ink">Print size metadata</h3>

      {status === "pass" ? (
        <p className="text-sm text-ink" data-sign-physical-resolution-status="pass">
          Correct — this file&apos;s embedded print size matches the ordered production size.
        </p>
      ) : status === "fail" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink" data-sign-physical-resolution-status="fail">
            This file&apos;s embedded print size doesn&apos;t match the ordered production size. Production software
            (e.g. CorelDRAW) would open it at the wrong size.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted" data-sign-physical-resolution-status="not_checked">
          Not yet verified for this candidate.
        </p>
      )}

      {needsFix ? (
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void handleRepair()}
            disabled={repairing}
            aria-busy={repairing}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-physical-resolution-repair-button"
          >
            {repairing ? "Correcting…" : "Fix print size metadata"}
          </button>
        </div>
      ) : null}

      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-physical-resolution-error>
          {error}
        </p>
      ) : null}
    </section>
  );
}
