"use client";

import type { DesignSummaryView } from "@/capabilities/shared/contracts";

interface DesignSummaryCardProps {
  summary: DesignSummaryView;
  busy: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onContinue: () => void;
}

const FIELD_LABELS: Array<[keyof DesignSummaryView, string]> = [
  ["product", "Product"],
  ["graphics", "Design Description"],
  ["productColor", "Product Color"],
  ["requiredWording", "Required Wording"],
  ["colors", "Preferred Colors"],
  ["style", "Style"],
  ["additionalNotes", "Additional Notes"],
];

export function DesignSummaryCard({
  summary,
  busy,
  onApprove,
  onEdit,
  onContinue,
}: DesignSummaryCardProps) {
  const rows = FIELD_LABELS.filter(([key]) =>
    Boolean(summary[key]?.toString().trim()),
  );

  return (
    <div className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Design Summary — here&apos;s what I understand so far
      </p>

      {rows.length > 0 ? (
        <dl className="mt-3 space-y-2">
          {rows.map(([key, label]) => (
            <div key={key} className="flex flex-wrap gap-2 text-sm">
              <dt className="w-36 shrink-0 font-medium text-ink">{label}</dt>
              <dd className="text-muted">{summary[key]}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onApprove}
          className="rounded-full bg-ink px-4 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Approve and Create Concepts
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onEdit}
          className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-ink transition enabled:hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Edit
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onContinue}
          className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-ink transition enabled:hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
        </button>
      </div>
    </div>
  );
}
