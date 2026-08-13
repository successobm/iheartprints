"use client";

/**
 * Existing Artwork → Print Ready Phase 1: the workflow choice near project
 * start.
 *
 * Two genuinely different jobs, stated in the customer's terms — "I want you
 * to make me a design" versus "I already have a design". Neither option is a
 * setting, a mode, or a technical toggle (Constitution §6.6), and choosing
 * "Create New Artwork" changes nothing at all: it simply dismisses this card
 * and the existing conversational interview continues exactly as before.
 */

interface WorkflowChoiceCardProps {
  busy: boolean;
  onCreateNew: () => void;
  onUploadExisting: () => void;
}

export function WorkflowChoiceCard({
  busy,
  onCreateNew,
  onUploadExisting,
}: WorkflowChoiceCardProps) {
  return (
    <div className="rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      <p className="text-sm font-semibold text-ink">
        How would you like to start?
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy}
          onClick={onCreateNew}
          className="rounded-xl border border-black/8 p-3 text-left transition enabled:hover:border-ink/30 enabled:hover:bg-black/[0.02] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="block text-sm font-medium text-ink">
            Create New Artwork
          </span>
          <span className="mt-1 block text-xs text-muted">
            Tell us what you have in mind and we&apos;ll design it with you.
          </span>
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onUploadExisting}
          className="rounded-xl border border-black/8 p-3 text-left transition enabled:hover:border-ink/30 enabled:hover:bg-black/[0.02] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="block text-sm font-medium text-ink">
            Upload Existing Artwork
          </span>
          <span className="mt-1 block text-xs text-muted">
            Already have a design? We&apos;ll get your artwork ready to print.
          </span>
        </button>
      </div>
    </div>
  );
}
