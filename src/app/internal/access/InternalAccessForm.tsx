"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { INTERNAL_ACCESS_KEY_HEADER } from "@/lib/config/internal-access-config";

/**
 * Phase 28M.1: the actual form. Deliberately the ONLY place in this
 * component that ever touches the raw key -- one controlled input, read
 * once at submit time to build a request header, never rendered back, never
 * assigned to any variable that outlives the submit handler, never logged.
 *
 * WHY A HEADER, NOT A NATIVE FORM POST
 *
 * `POST /api/internal/acquisition-access` (unchanged by this phase) expects
 * the key in the `x-iheartprints-internal-key` header, exactly as
 * `internal-access-config.ts` documents -- a header rather than a body field
 * specifically so it is never logged as request content and never a URL
 * component. A native `<form>` submission cannot set a custom header, so
 * this uses `fetch` -- the same client-side request pattern every other
 * mutating action in this app already uses (`ChatApp.tsx`,
 * `SeparationReviewPanel.tsx`, `CorrectionWorkspace.tsx`, ...). The key
 * exists in this component's state for exactly as long as the user is
 * typing it and this one request is in flight; nothing persists it, and the
 * component unmounts on the success redirect below.
 *
 * NEVER: localStorage, sessionStorage, a URL/query parameter, a
 * `console.log`, or a value echoed back into the DOM after submission.
 */
export function InternalAccessForm() {
  const router = useRouter();
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!key.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/internal/acquisition-access", {
        method: "POST",
        headers: { [INTERNAL_ACCESS_KEY_HEADER]: key },
      });
      if (!res.ok) {
        // Deliberately uninformative -- the same 401 covers "wrong key" and
        // "not configured", exactly as the endpoint itself never
        // distinguishes them (`internal-access-config.ts`).
        setError("That didn't work. Check your key and try again.");
        setSubmitting(false);
        return;
      }
      // A real, browser-managed cookie -- Next.js includes it on the RSC
      // request this navigation makes regardless of push vs. a hard reload,
      // so the destination page sees the new session immediately either way.
      router.push("/");
    } catch {
      setError("That didn't work. Check your key and try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium text-ink">Access Key</span>
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={submitting}
          className="rounded-lg border border-black/15 px-3 py-2 text-sm outline-none focus:border-ink/40"
          data-testid="internal-access-key-input"
        />
      </label>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-internal-access-error>
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={submitting || !key.trim()}
        className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {submitting ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}
