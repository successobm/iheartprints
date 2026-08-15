"use client";

import { useState } from "react";

import {
  EMAIL_PURPOSE_NOTE,
  EMAIL_REQUIRED_HEADLINE,
  EMAIL_REQUIRED_MESSAGE,
  EMAIL_SUBMIT_LABEL,
  validateEmail,
} from "@/capabilities/acquisition";

/**
 * Sprint A4 (Goal 13): the email continuation gate.
 *
 * Deliberately one input and one button. There is no password field, no
 * confirmation field, no marketing checkbox (pre-checked or otherwise), no
 * terms acceptance, and no "create your account" framing — because none of
 * those things is happening. Adding any of them would make the copy beside
 * the input untrue.
 *
 * It is a `<form>`, not a div with a click handler, so Enter submits and
 * the browser's own labelling/autofill work. `type="email"` +
 * `autoComplete="email"` for the same reason.
 *
 * Client-side validation here is a courtesy that saves a round trip, never
 * the authority: it calls the SAME pure validator the server uses, and the
 * server validates again regardless.
 */
export function EmailContinuationGate({
  busy,
  onSubmit,
}: {
  busy: boolean;
  /** Resolves to a customer-safe message on failure, or `null` on success. */
  onSubmit: (email: string) => Promise<string | null>;
}) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const disabled = busy || submitting;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;

    const validation = validateEmail(email);
    if (!validation.valid) {
      setMessage(validation.message);
      return;
    }

    setSubmitting(true);
    setMessage(null);
    try {
      setMessage(await onSubmit(validation.email));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm"
    >
      <p className="text-sm font-medium text-ink">{EMAIL_REQUIRED_HEADLINE}</p>
      <p className="mt-1 text-sm text-ink">{EMAIL_REQUIRED_MESSAGE}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="acquisition-email">
          Email address
        </label>
        <input
          id="acquisition-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          value={email}
          disabled={disabled}
          onChange={(event) => {
            setEmail(event.target.value);
            // Clearing on edit rather than re-validating on every keystroke:
            // telling someone their address is invalid while they are still
            // typing it is noise, not help.
            if (message) setMessage(null);
          }}
          placeholder="you@example.com"
          aria-invalid={message !== null}
          aria-describedby="acquisition-email-note"
          className="min-w-0 flex-1 rounded-full border border-black/10 px-3.5 py-1.5 text-sm text-ink outline-none transition focus:border-ink/40 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled}
          className="shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? "Saving…" : EMAIL_SUBMIT_LABEL}
        </button>
      </div>

      {message ? (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {message}
        </p>
      ) : null}

      <p id="acquisition-email-note" className="mt-2 text-xs text-muted">
        {EMAIL_PURPOSE_NOTE}
      </p>
    </form>
  );
}
