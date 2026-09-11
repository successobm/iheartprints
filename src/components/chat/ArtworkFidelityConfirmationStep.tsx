"use client";

import { useEffect, useRef, useState } from "react";

import type { ProtectedMarkType } from "@/lib/domain/types";
import type { ArtworkFidelityView } from "@/lib/services/conversation-service";

/**
 * Universal Raster Reconstruction Phase R4A: "We found the following in
 * your artwork" — the customer confirmation surface for a proposed
 * `ArtworkFidelityContract`. Self-contained (fetches/writes its own state
 * against `/api/projects/[projectId]/artwork-fidelity`), mirroring
 * `SeparationReviewPanel`'s own "this panel never reads or recomputes state
 * itself — only mounts the surface that does" precedent.
 *
 * VISION PROPOSES, CUSTOMER CONFIRMS — never the reverse:
 *   - a `readable`, prefilled field is still fully editable;
 *   - a `partially_readable`/`cannot_read` field is NEVER prefilled with a
 *     guess — the customer must type it themselves, or explicitly mark it
 *     not present, before confirmation is possible (Section 9);
 *   - a protected-mark question is NEVER pre-selected to the provider's own
 *     guess (Section 6) — the customer must explicitly choose ™ / ® / © /
 *     None / Not sure;
 *   - "Not sure" is a valid, honestly-recorded selection but BLOCKS
 *     confirmation (Section 8) — it is not itself a confirmation.
 *
 * Deliberately hides every implementation term (Section 6): no "fidelity
 * contract", "model", "OCR", "confidence score", "provenance",
 * "contractKey", "reconstruction provider", or "semantic verification"
 * appears anywhere in this component's rendered text.
 *
 * Phase R4A-R (independent-review repair):
 *   - every field carries the SAME stable `id` the server assigned when it
 *     built the proposal (`ArtworkFidelityView.wording[].id`/
 *     `.protectedMarks[].id`) — submitted back as `wordingResolutions`/
 *     `markResolutions` so the server can prove every proposed region was
 *     actually addressed, never trusting array position/order alone
 *     (Blocker 2/§4).
 *   - the mark question list is read directly from
 *     `view.protectedMarks` with no client-side synthesis any more — the
 *     server itself now guarantees at least one entry (a labeled catch-all
 *     when nothing was detected), so what the customer sees and what the
 *     server will validate against are always the exact same set of ids
 *     (Blocker 2/§5).
 *   - `view.proposalStatus` distinguishes a genuine successful check that
 *     found nothing from the provider being unavailable/misconfigured/
 *     failed (Blocker 3/§6) — the two render visibly different copy.
 *
 * Production Acceptance Defect fix (post-merge): this component originally
 * carried ZERO Tailwind utility classes anywhere. Tailwind's own preflight
 * reset (active app-wide, `src/app/globals.css`) strips default browser
 * button/form chrome, so an unclassed `<button>` renders as plain inline
 * text and unclassed `<input type="radio">`/`<label>` pairs render cramped
 * together with no spacing — exactly the reported production symptom. The
 * elements were always real, functional, keyboard-accessible controls; this
 * was a pure styling gap, never a wrong-element bug. Every class below is
 * copied verbatim from an existing, already-shipped control in this SAME
 * panel (`UploadedArtworkPanel.tsx`) — never a new visual design:
 *   - primary button: `SignContextSavedStep`'s "Check my artwork" button.
 *   - secondary/text button: the QR step's "Print as supplied" button.
 *   - selectable choice chips: `DetailsStep`'s `PLACEMENT_OPTIONS` group
 *     (`<button aria-pressed>` pills), extended here to cover all five mark
 *     choices (™/®/©/None/Not sure) in one row instead of two.
 *   - text input / card / alert styling: the same utility classes already
 *     used throughout this file for every other field/status message.
 * Strictly presentational — no authority/validation/routing logic changed;
 * every state transition below is byte-identical to before this fix.
 */

/**
 * The customer's SELECTION here is the actual confirmed-authority symbol
 * (`ProtectedMarkType` = `"™" | "®" | "©"`) — NOT the provider's own
 * proposal classification codes (`"TM" | "R" | "C"`, `contracts.ts`'s
 * `MarkClassificationProposal`), which are an internal proposal-schema
 * detail never surfaced to the customer or submitted as confirmed
 * authority. `"NOT_SURE"` is included in this SAME rendered chip row
 * (Production Acceptance Defect fix — previously a visually separate radio
 * outside the option list) but remains excluded from what may ever be
 * submitted as a confirmed mark (`handleConfirm` still only ever sends
 * `ProtectedMarkType | "NONE"`, and `marksComplete` still blocks on it).
 */
const MARK_OPTIONS: { value: ProtectedMarkType | "NONE" | "NOT_SURE"; label: string }[] = [
  { value: "™", label: "™" },
  { value: "®", label: "®" },
  { value: "©", label: "©" },
  { value: "NONE", label: "None of these" },
  { value: "NOT_SURE", label: "Not sure" },
];

type MarkSelection = ProtectedMarkType | "NONE" | "NOT_SURE" | null;

interface WordingFieldState {
  id: string;
  readable: boolean;
  value: string;
  /** Explicit "this text is not actually in my artwork" — the safe way to resolve an entry without typing anything (Section 9). */
  notPresent: boolean;
}

interface MarkFieldState {
  id: string;
  visualDescription: string;
  selection: MarkSelection;
}

function initialWordingFields(view: ArtworkFidelityView | null): WordingFieldState[] {
  if (!view) return [];
  return view.wording.map((w) => ({
    id: w.id,
    readable: w.readability === "readable",
    // Never prefill an uncertain guess — only a `readable` proposal is
    // trusted enough to prefill, and even then the customer can edit it.
    value: w.readability === "readable" ? (w.text ?? "") : "",
    notPresent: false,
  }));
}

function initialMarkFields(view: ArtworkFidelityView | null): MarkFieldState[] {
  if (!view) return [];
  // The server always returns at least one mark entry now (a labeled
  // catch-all when nothing was detected) -- see `assignMarkIds` in
  // `artwork-fidelity-proposal-capability.ts`. No client-side synthesis.
  return view.protectedMarks.map((m) => ({ id: m.id, visualDescription: m.visualDescription, selection: null }));
}

export interface ArtworkFidelityConfirmationStepProps {
  projectId: string;
  artworkFidelity: ArtworkFidelityView | null;
  busy?: boolean;
  /** Confirmation succeeded — parent should refetch its snapshot; the derived step advances on its own once `artworkFidelity.status === "confirmed"`. */
  onConfirmed: () => void;
  /** "Skip for now" — client-only, never a server call (Section 13: this step must never block a currently valid flow). */
  onSkip: () => void;
}

export function ArtworkFidelityConfirmationStep(
  props: ArtworkFidelityConfirmationStepProps,
) {
  const { projectId, onConfirmed, onSkip } = props;
  const [view, setView] = useState(props.artworkFidelity);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wordingFields, setWordingFields] = useState<WordingFieldState[]>(() =>
    initialWordingFields(props.artworkFidelity),
  );
  const [markFields, setMarkFields] = useState<MarkFieldState[]>(() =>
    initialMarkFields(props.artworkFidelity),
  );
  const proposeStarted = useRef(false);

  // Auto-check once, the first time this step is reached with nothing
  // proposed yet — "upload artwork, receive proposed facts" (Steps 1-2)
  // happen as one continuous action rather than requiring an extra click.
  // Never re-fires for an already-proposed/confirmed view.
  useEffect(() => {
    if (view || proposeStarted.current) return;
    proposeStarted.current = true;
    setChecking(true);
    setError(null);
    fetch(`/api/projects/${projectId}/artwork-fidelity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "propose" }),
    })
      .then(async (res) => {
        const body = (await res.json()) as { artworkFidelity?: ArtworkFidelityView; error?: string };
        if (!res.ok) throw new Error(body.error || "We couldn't check your artwork right now.");
        const next = body.artworkFidelity ?? null;
        setView(next);
        setWordingFields(initialWordingFields(next));
        setMarkFields(initialMarkFields(next));
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "We couldn't check your artwork right now.");
      })
      .finally(() => setChecking(false));
  }, [projectId, view]);

  const wordingComplete = wordingFields.every((f) => f.notPresent || f.value.trim().length > 0);
  const marksComplete = markFields.every((f) => f.selection !== null && f.selection !== "NOT_SURE");
  const canConfirm = !checking && !submitting && wordingComplete && marksComplete;

  async function handleConfirm() {
    if (!canConfirm) return;
    setSubmitting(true);
    setError(null);
    const wordingResolutions = wordingFields.map((f) =>
      f.notPresent ? { id: f.id, excluded: true } : { id: f.id, text: f.value.trim() },
    );
    const markResolutions = markFields.map((f) => ({
      id: f.id,
      // canConfirm already guarantees every selection is a real, non-null,
      // non-"NOT_SURE" value at this point.
      mark: f.selection as ProtectedMarkType | "NONE",
    }));
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-fidelity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", wordingResolutions, markResolutions }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "We couldn't save those details. Please try again.");
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save those details. Please try again.");
      setSubmitting(false);
    }
  }

  const nothingToConfirm =
    !checking && view !== null && wordingFields.length === 0 && markFields.length === 0;

  return (
    <section
      aria-label="Confirm what's in your artwork"
      className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-semibold text-ink">Confirm what&rsquo;s in your artwork</p>
      {view && view.proposalStatus === "unavailable" ? (
        <p className="mt-1 text-sm text-muted">
          We couldn&rsquo;t check your artwork automatically. Please enter the text and symbols that must be preserved.
        </p>
      ) : (
        <p className="mt-1 text-sm text-muted">
          We found the following text and symbols. Please correct anything that doesn&rsquo;t look right.
        </p>
      )}

      {checking ? (
        <p role="status" className="mt-3 text-sm text-muted">
          Checking your artwork…
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {error}
        </p>
      ) : null}

      {nothingToConfirm ? (
        <p className="mt-3 text-sm text-muted">
          {view?.proposalStatus === "unavailable"
            ? "We couldn't check your artwork automatically, and didn't find anything to resolve below. You can still confirm if your artwork truly has no text or symbols to preserve."
            : "We checked your artwork but didn't find readable text or symbols. Please confirm what's present."}
        </p>
      ) : null}

      {wordingFields.length > 0 ? (
        <div className="mt-3 grid gap-3">
          {wordingFields.map((field, index) => (
            <div key={field.id}>
              <label htmlFor={`fidelity-wording-${field.id}`} className="block">
                <span className="text-xs font-medium text-ink">
                  Text{wordingFields.length > 1 ? ` ${index + 1}` : ""}
                </span>
                {field.readable ? null : (
                  <p className="mt-0.5 text-xs text-muted">
                    We couldn&rsquo;t clearly read this — please type what it says.
                  </p>
                )}
                <input
                  id={`fidelity-wording-${field.id}`}
                  type="text"
                  value={field.value}
                  disabled={field.notPresent || submitting}
                  onChange={(e) => {
                    const next = e.target.value;
                    setWordingFields((prev) => prev.map((f) => (f.id === field.id ? { ...f, value: next } : f)));
                  }}
                  className="mt-1 w-full rounded-xl border border-black/10 px-3 py-2 text-sm text-ink outline-none focus:border-ink/40 disabled:opacity-50"
                  data-testid={`artwork-fidelity-wording-input-${field.id}`}
                />
              </label>
              <label className="mt-1.5 flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={field.notPresent}
                  disabled={submitting}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setWordingFields((prev) =>
                      prev.map((f) => (f.id === field.id ? { ...f, notPresent: checked, value: checked ? "" : f.value } : f)),
                    );
                  }}
                  className="h-4 w-4 rounded border-black/20 text-ink focus:ring-ink/40"
                  data-testid={`artwork-fidelity-wording-exclude-${field.id}`}
                />
                This text isn&rsquo;t actually in my artwork
              </label>
            </div>
          ))}
        </div>
      ) : null}

      {markFields.map((field) => (
        <fieldset key={field.id} className="mt-3">
          <legend className="text-xs font-medium text-ink">
            {field.visualDescription
              ? "We found a small symbol here. Is it:"
              : "Does your artwork include a ™, ®, or © symbol?"}
          </legend>
          {field.visualDescription ? (
            <p className="mt-0.5 text-xs text-muted">{field.visualDescription}</p>
          ) : null}
          <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup">
            {MARK_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={submitting}
                aria-pressed={field.selection === option.value}
                onClick={() =>
                  setMarkFields((prev) =>
                    prev.map((f) => (f.id === field.id ? { ...f, selection: option.value } : f)),
                  )
                }
                className={`rounded-full px-3 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${
                  field.selection === option.value
                    ? "bg-ink text-white"
                    : "border border-black/10 text-muted hover:border-ink/30 hover:text-ink"
                }`}
                data-testid={`artwork-fidelity-mark-option-${field.id}-${option.value}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void handleConfirm()}
          disabled={!canConfirm}
          className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="artwork-fidelity-confirm-button"
        >
          Confirm Artwork Details
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="artwork-fidelity-skip-button"
        >
          Skip for now
        </button>
      </div>
    </section>
  );
}
