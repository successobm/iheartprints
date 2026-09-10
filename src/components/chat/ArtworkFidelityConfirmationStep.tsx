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
 */

/**
 * The customer's SELECTION here is the actual confirmed-authority symbol
 * (`ProtectedMarkType` = `"™" | "®" | "©"`) — NOT the provider's own
 * proposal classification codes (`"TM" | "R" | "C"`, `contracts.ts`'s
 * `MarkClassificationProposal`), which are an internal proposal-schema
 * detail never surfaced to the customer or submitted as confirmed
 * authority.
 */
const MARK_OPTIONS: { value: ProtectedMarkType | "NONE"; label: string }[] = [
  { value: "™", label: "™" },
  { value: "®", label: "®" },
  { value: "©", label: "©" },
  { value: "NONE", label: "None of these" },
];

type MarkSelection = ProtectedMarkType | "NONE" | "NOT_SURE" | null;

interface WordingFieldState {
  /** `null` for a proposal entry with no ground truth to compare against, kept for the "correct anything that doesn't look right" prefill rule. */
  proposedText: string | null;
  readable: boolean;
  value: string;
  /** Explicit "this text is not actually in my artwork" — the safe way to resolve an entry without typing anything (Section 9). */
  notPresent: boolean;
}

interface MarkFieldState {
  visualDescription: string;
  selection: MarkSelection;
}

function initialWordingFields(view: ArtworkFidelityView | null): WordingFieldState[] {
  if (!view) return [];
  return view.wording.map((w) => ({
    proposedText: w.text,
    readable: w.readability === "readable",
    // Never prefill an uncertain guess — only a `readable` proposal is
    // trusted enough to prefill, and even then the customer can edit it.
    value: w.readability === "readable" ? (w.text ?? "") : "",
    notPresent: false,
  }));
}

function initialMarkFields(view: ArtworkFidelityView | null): MarkFieldState[] {
  if (!view) return [];
  if (view.protectedMarks.length === 0) {
    // No region detected at all — still one explicit question, never a
    // silent default (Section 6/8).
    return [{ visualDescription: "", selection: null }];
  }
  return view.protectedMarks.map((m) => ({ visualDescription: m.visualDescription, selection: null }));
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
    const confirmedWording = wordingFields
      .filter((f) => !f.notPresent)
      .map((f) => f.value.trim())
      .filter((text) => text.length > 0);
    const confirmedMarks = Array.from(
      new Set(
        markFields
          .map((f) => f.selection)
          .filter((s): s is ProtectedMarkType => s === "™" || s === "®" || s === "©"),
      ),
    );
    try {
      const res = await fetch(`/api/projects/${projectId}/artwork-fidelity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "confirm", confirmedWording, confirmedMarks }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || "We couldn't save those details. Please try again.");
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "We couldn't save those details. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <section aria-label="Confirm what's in your artwork">
      <h3>Confirm what&rsquo;s in your artwork</h3>
      <p>We found the following text and symbols. Please correct anything that doesn&rsquo;t look right.</p>

      {checking ? <p role="status">Checking your artwork…</p> : null}
      {error ? <p role="alert">{error}</p> : null}

      {!checking && wordingFields.length === 0 && markFields.length === 0 ? (
        <p>We didn&rsquo;t find any text or symbols to confirm.</p>
      ) : null}

      {wordingFields.map((field, index) => (
        <div key={index}>
          <label htmlFor={`fidelity-wording-${index}`}>Text{wordingFields.length > 1 ? ` ${index + 1}` : ""}</label>
          {field.readable ? null : (
            <p>We couldn&rsquo;t clearly read this — please type what it says.</p>
          )}
          <input
            id={`fidelity-wording-${index}`}
            type="text"
            value={field.value}
            disabled={field.notPresent || submitting}
            onChange={(e) => {
              const next = e.target.value;
              setWordingFields((prev) => prev.map((f, i) => (i === index ? { ...f, value: next } : f)));
            }}
          />
          <label>
            <input
              type="checkbox"
              checked={field.notPresent}
              disabled={submitting}
              onChange={(e) => {
                const checked = e.target.checked;
                setWordingFields((prev) =>
                  prev.map((f, i) => (i === index ? { ...f, notPresent: checked, value: checked ? "" : f.value } : f)),
                );
              }}
            />
            This text isn&rsquo;t actually in my artwork
          </label>
        </div>
      ))}

      {markFields.map((field, index) => (
        <fieldset key={index}>
          <legend>
            {field.visualDescription
              ? "We found a small symbol here. Is it:"
              : "Does your artwork include a ™, ®, or © symbol?"}
          </legend>
          {field.visualDescription ? <p>{field.visualDescription}</p> : null}
          {MARK_OPTIONS.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name={`fidelity-mark-${index}`}
                checked={field.selection === option.value}
                disabled={submitting}
                onChange={() =>
                  setMarkFields((prev) =>
                    prev.map((f, i) => (i === index ? { ...f, selection: option.value } : f)),
                  )
                }
              />
              {option.label}
            </label>
          ))}
          <label>
            <input
              type="radio"
              name={`fidelity-mark-${index}`}
              checked={field.selection === "NOT_SURE"}
              disabled={submitting}
              onChange={() =>
                setMarkFields((prev) => prev.map((f, i) => (i === index ? { ...f, selection: "NOT_SURE" } : f)))
              }
            />
            Not sure
          </label>
        </fieldset>
      ))}

      <button type="button" onClick={() => void handleConfirm()} disabled={!canConfirm}>
        Confirm Artwork Details
      </button>
      <button type="button" onClick={onSkip} disabled={submitting}>
        Skip for now
      </button>
    </section>
  );
}
