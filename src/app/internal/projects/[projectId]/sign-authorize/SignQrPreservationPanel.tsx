"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SignMachineReadableContentSummary } from "@/capabilities/sign-preparation";

/**
 * SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION / DESTINATION
 * RESOLUTION.
 *
 * A QR code is machine-readable semantic content, not an ordinary
 * decorative region — visual similarity between a source QR and a
 * reconstructed one is never equivalent to functional equivalence. This
 * panel makes that problem understandable to the operator (Section W) and
 * exposes FOUR governed actions, all mirroring the SAME fetch →
 * `router.refresh()` pattern every other operator action on this page
 * already uses:
 *
 *   "Check QR code"       — read-only to the artwork. Always available
 *                            once a production candidate exists. Decodes
 *                            the source and the current candidate,
 *                            compares, and persists the result.
 *
 *   "Restore QR code"     — only rendered when the last check found a
 *                            PROVEN regression (a source QR that decoded,
 *                            but the candidate lost or changed it) OR a
 *                            pending confirmed destination not yet applied
 *                            to the candidate.
 *
 *   "Fix QR code"         — the operator's own way to confirm a detected-
 *                            but-undecodable QR's destination — the SAME
 *                            action the customer has, offered here too
 *                            (Section T: Eric is also the operator).
 *
 *   "Print as supplied"   — an explicit acknowledgment that no functioning
 *                            QR is required. Never claims verification.
 *
 * Truthfully distinguishes PROVENANCE (Section AC): "Destination
 * confirmed" for a customer/operator-confirmed destination is never
 * described as "Verified from original QR".
 *
 * No raw internal vocabulary (`machine_readable_content_preserved`,
 * `planKey`, payload hashes, `jsQR`) ever reaches this component's
 * rendered copy.
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
  const [destination, setDestination] = useState("");
  const [submittingDestination, setSubmittingDestination] = useState(false);
  const [submittingPrintAsSupplied, setSubmittingPrintAsSupplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = checking || restoring || submittingDestination || submittingPrintAsSupplied;

  async function runNoBodyAction(path: "qr-check" | "qr-restore", setBusy: (v: boolean) => void) {
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

  async function runResolutionAction(
    path: "qr-destination" | "qr-print-as-supplied",
    body: Record<string, string>,
    setBusy: (v: boolean) => void,
  ) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(responseBody?.error ?? "That didn't work. Please try again.");
        setBusy(false);
        return;
      }
      setDestination("");
      router.refresh();
      setBusy(false);
    } catch {
      setError("That didn't work. Please try again.");
      setBusy(false);
    }
  }

  const overall = machineReadableContent?.overall ?? null;
  const regionCount = machineReadableContent?.regions.length ?? 0;
  const confirmedCount =
    machineReadableContent?.regions.filter((r) => r.result === "pass" && r.provenance === "confirmed_by_user")
      .length ?? 0;
  const sourceVerifiedCount =
    machineReadableContent?.regions.filter((r) => r.result === "pass" && r.provenance === "verified_from_source_qr")
      .length ?? 0;
  const needsAttentionRegion = machineReadableContent?.regions.find(
    (r) => r.result === "review_required" && r.regionKey !== null,
  );
  const canRestore =
    overall === "fail" ||
    overall === "hard_fail" ||
    (needsAttentionRegion !== undefined && destination.trim().length === 0);
  // Fix QR Review UX Phase, Section O: once evidence already exists as
  // `review_required`, nothing about the immutable source has changed —
  // re-running the identical deterministic comparison reproduces the
  // identical, still-unresolved result every time. The resolution actions
  // ("Fix QR code"/"Print as supplied") below dominate instead of
  // encouraging a repeated, meaningless re-check. Every other state
  // (never checked, pass, fail/hard_fail, accepted_as_supplied,
  // not_applicable) keeps the button — a genuine re-check remains
  // meaningful for those.
  const showCheckButton = overall !== "review_required";

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
          {confirmedCount > 0 && sourceVerifiedCount === 0
            ? `Destination confirmed${regionCount > 1 ? ` (${regionCount} codes)` : ""}.`
            : `Verified — destination preserved${regionCount > 1 ? ` (${regionCount} codes)` : ""}.`}
        </p>
      ) : overall === "accepted_as_supplied" ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm text-ink" data-sign-qr-status="accepted_as_supplied">
            Printed as supplied — the QR code was not verified to scan.
          </p>
        </div>
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

      {needsAttentionRegion?.regionKey ? (
        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <label className="block">
            <span className="text-xs font-medium text-ink">Destination</span>
            <input
              type="text"
              value={destination}
              disabled={busy}
              maxLength={500}
              placeholder="Enter confirmed QR destination"
              // Fix QR Review UX Phase: this field starts empty (`useState("")`
              // above) and is NEVER seeded from any visible artwork text,
              // OCR-like inference, or business identity — only an
              // operator's own explicit keystrokes ever populate it.
              // `autoComplete="off"` additionally defends against a
              // BROWSER silently re-suggesting a value it remembers from
              // an unrelated prior manual entry in this same field — the
              // real, empirically-confirmed cause of a customer/operator
              // ever seeing an unverified destination pre-filled here.
              autoComplete="off"
              onChange={(event) => setDestination(event.target.value)}
              className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
              data-testid="sign-qr-destination-input"
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy || destination.trim().length === 0}
              onClick={() =>
                void runResolutionAction(
                  "qr-destination",
                  { regionKey: needsAttentionRegion.regionKey!, destination: destination.trim() },
                  setSubmittingDestination,
                )
              }
              className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
              data-testid="sign-qr-fix-button"
            >
              {submittingDestination ? "Working…" : "Fix QR code"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void runResolutionAction(
                  "qr-print-as-supplied",
                  { regionKey: needsAttentionRegion.regionKey! },
                  setSubmittingPrintAsSupplied,
                )
              }
              className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="sign-qr-print-as-supplied-button"
            >
              Print as supplied
            </button>
          </div>
          <p className="text-xs text-muted">
            The QR code could not be verified. Printing as supplied may result in a QR code that does not scan.
          </p>
        </div>
      ) : null}

      <div className="mt-1 flex flex-wrap items-center gap-3">
        {showCheckButton ? (
          <button
            type="button"
            onClick={() => void runNoBodyAction("qr-check", setChecking)}
            disabled={busy}
            aria-busy={checking}
            className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-medium text-ink transition enabled:hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="sign-qr-check-button"
          >
            {checking ? "Checking…" : "Check QR code"}
          </button>
        ) : null}
        {canRestore ? (
          <button
            type="button"
            onClick={() => void runNoBodyAction("qr-restore", setRestoring)}
            disabled={busy}
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
