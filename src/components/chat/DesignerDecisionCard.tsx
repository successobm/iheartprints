"use client";

interface DesignerDecisionCardProps {
  message: string;
}

/**
 * Sprint 2G Part 3: shown when the customer explicitly defers a decision
 * ("You choose.") — framed as a completed decision the designer will
 * handle well, never as a gap or something still missing.
 */
export function DesignerDecisionCard({ message }: DesignerDecisionCardProps) {
  return (
    <div className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">
        Designer Decision
      </p>
      <p className="mt-1.5 text-sm text-ink">{message}</p>
    </div>
  );
}
