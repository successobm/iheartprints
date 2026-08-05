"use client";

import type {
  BriefSectionKey,
  DeferredDecisionView,
  DesignSummaryView,
} from "@/capabilities/shared/contracts";

export interface FieldTransition {
  from: string | null;
  to: string;
}

interface DesignSummaryCardProps {
  summary: DesignSummaryView;
  /** Sections the designer will decide — a completed decision, never shown as missing. */
  deferredDecisions?: DeferredDecisionView[];
  /** Sections that changed since the last time a summary was shown. */
  updatedSections?: BriefSectionKey[];
  /** Old → new value for updated sections that had a prior value worth showing. */
  fieldTransitions?: Record<string, FieldTransition>;
  busy: boolean;
  onApprove: () => void;
  onEdit: () => void;
  onContinue: () => void;
}

const FIELD_LABELS: Array<[keyof DesignSummaryView, string]> = [
  ["product", "Product"],
  ["graphics", "Design Description"],
  ["productColor", "Product Color"],
  ["printLocation", "Print Location"],
  ["requiredWording", "Required Wording"],
  ["style", "Style"],
  ["colors", "Preferred Colors"],
  ["audience", "Audience"],
  ["purpose", "Purpose"],
  ["exclusions", "Exclusions"],
  ["additionalNotes", "Additional Notes"],
];

export function DesignSummaryCard({
  summary,
  deferredDecisions = [],
  updatedSections = [],
  fieldTransitions = {},
  busy,
  onApprove,
  onEdit,
  onContinue,
}: DesignSummaryCardProps) {
  const rows = FIELD_LABELS.filter(([key]) =>
    Boolean(summary[key]?.toString().trim()),
  );
  const updatedSet = new Set<string>(updatedSections);

  return (
    <div className="mt-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Design Summary — here&apos;s what I understand so far
      </p>

      {rows.length > 0 ? (
        <dl className="mt-3 space-y-2">
          {rows.map(([key, label]) => {
            const isUpdated = updatedSet.has(key);
            const transition = fieldTransitions[key];
            return (
              <div
                key={key}
                className={[
                  "flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg px-2 py-1 text-sm transition-colors",
                  isUpdated ? "bg-amber-50 ring-1 ring-amber-200" : "",
                ].join(" ")}
              >
                <dt className="w-36 shrink-0 font-medium text-ink">{label}</dt>
                <dd className="text-muted">
                  {transition?.from ? (
                    <span>
                      <span className="text-muted/70 line-through">
                        {transition.from}
                      </span>{" "}
                      <span aria-hidden="true">→</span> {transition.to}
                    </span>
                  ) : (
                    summary[key]
                  )}
                </dd>
                {isUpdated ? (
                  <span
                    className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
                    aria-label={`${label} was just updated`}
                  >
                    Updated
                  </span>
                ) : null}
              </div>
            );
          })}
        </dl>
      ) : null}

      {deferredDecisions.length > 0 ? (
        <div className="mt-4 rounded-xl bg-black/[0.03] p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Designer will determine
          </p>
          <ul className="mt-2 space-y-1">
            {deferredDecisions.map((decision) => (
              <li key={decision.section} className="flex gap-2 text-sm text-ink">
                <span aria-hidden="true">•</span>
                <span>{decision.label}</span>
              </li>
            ))}
          </ul>
        </div>
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
