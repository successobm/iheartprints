"use client";

import type { RecommendationAction } from "@/capabilities/shared/contracts";

interface RecommendationCardProps {
  message: string;
  actions: RecommendationAction[];
  busy: boolean;
  onAction: (replyText: string) => void;
}

/**
 * Sprint 2G Part 3: a small advisor card for a Design Intelligence
 * recommendation. Every action just sends its `replyText` through the
 * normal chat pipeline — identical to the customer typing it — so no new
 * mutation path exists for a card to bypass. Customers remain in control:
 * every recommendation offers a non-destructive way out.
 */
export function RecommendationCard({
  message,
  actions,
  busy,
  onAction,
}: RecommendationCardProps) {
  return (
    <div className="mt-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-sky-700">
        Recommendation
      </p>
      <p className="mt-1.5 text-sm text-ink">{message}</p>
      {actions.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled={busy}
              onClick={() => onAction(action.replyText)}
              className={[
                "rounded-full px-3.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40",
                action.kind === "apply"
                  ? "bg-ink text-white enabled:hover:bg-ink/90"
                  : "border border-black/10 bg-white text-ink enabled:hover:bg-black/5",
              ].join(" ")}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
