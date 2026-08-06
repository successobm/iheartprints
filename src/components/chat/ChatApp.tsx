"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BriefSectionKey,
  DeferredDecisionView,
  DesignSummaryView,
  RecommendationAction,
} from "@/capabilities/shared/contracts";
import type { ApiProjectSnapshot } from "@/lib/services/conversation-service";
import {
  CHAT_PROJECT_STORAGE_KEY,
  planSessionBootstrap,
} from "./chat-session";
import { Composer } from "./Composer";
import { ConceptCards } from "./ConceptCards";
import { ConceptStatusBanner } from "./ConceptStatusBanner";
import { DesignerDecisionCard } from "./DesignerDecisionCard";
import { DesignSummaryCard, type FieldTransition } from "./DesignSummaryCard";
import { MessageBubble } from "./MessageBubble";
import { RecommendationCard } from "./RecommendationCard";
import { buildRevisionTimeline } from "./revision-timeline";
import { RevisionTimeline } from "./RevisionTimeline";
import { useIsClient } from "./use-is-client";

type ApiSnapshot = ApiProjectSnapshot & {
  persistenceMode?: "supabase" | "local";
};

export function ChatApp() {
  const isClient = useIsClient();
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conceptBannerDismissed, setConceptBannerDismissed] = useState(false);
  const previousConceptStatusRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isClient) return;
    void bootstrap();
  }, [isClient]);

  useEffect(() => {
    if (!isClient) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [isClient, snapshot?.messages.length, snapshot?.artworkVersions.length, sending]);

  // Sprint 2G Part 3: a dismissed "needs update" banner stays dismissed for
  // that episode — "do not repeatedly interrupt" — but reappears if a
  // *new* change makes concepts stale again after being current.
  useEffect(() => {
    const currentStatus = snapshot?.conceptStatus.status ?? null;
    if (
      currentStatus === "needs_update" &&
      previousConceptStatusRef.current !== "needs_update"
    ) {
      setConceptBannerDismissed(false);
    }
    previousConceptStatusRef.current = currentStatus;
  }, [snapshot?.conceptStatus.status]);

  // Sprint 2H Part 2A: concept generation now runs in the background —
  // while the project is "generating", poll a lightweight status endpoint
  // (never the full snapshot) until it flips, then refresh once for the
  // real result. No manual reload, no reopening the conversation.
  useEffect(() => {
    if (!isClient || !snapshot || snapshot.project.status !== "generating") {
      return;
    }

    const projectId = snapshot.project.id;
    let cancelled = false;
    const POLL_INTERVAL_MS = 3000;

    const interval = setInterval(() => {
      void (async () => {
        if (cancelled) return;
        try {
          const response = await fetch(
            `/api/projects/${projectId}/generation/status`,
          );
          if (!response.ok || cancelled) return;
          const data = (await response.json()) as { status: string };
          if (data.status !== "generating" && !cancelled) {
            // Inlined rather than calling the component's `refresh` —
            // keeps this effect's dependency list accurate (`projectId`
            // above, captured once per poll cycle) instead of depending
            // on a per-render function identity.
            const full = await fetch(`/api/projects/${projectId}`);
            if (full.ok && !cancelled) {
              setSnapshot((await full.json()) as ApiSnapshot);
            }
          }
        } catch {
          // Transient polling error — the next tick tries again.
        }
      })();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Deliberately scoped to just status/id, not the whole snapshot object
    // — restarting this interval on every unrelated snapshot update (a new
    // message, a summary edit, ...) would fight the polling cadence below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient, snapshot?.project.status, snapshot?.project.id]);

  async function bootstrap() {
    setLoading(true);
    setError(null);

    try {
      const plan = planSessionBootstrap(
        window.localStorage.getItem(CHAT_PROJECT_STORAGE_KEY),
      );

      if (plan.action === "restore") {
        const response = await fetch(`/api/projects/${plan.projectId}`);
        if (response.ok) {
          const data = (await response.json()) as ApiSnapshot;
          setSnapshot(data);
          return;
        }
        window.localStorage.removeItem(CHAT_PROJECT_STORAGE_KEY);
      }

      const created = await fetch("/api/projects", { method: "POST" });
      if (!created.ok) throw new Error("Could not start conversation");
      const data = (await created.json()) as ApiSnapshot;
      window.localStorage.setItem(CHAT_PROJECT_STORAGE_KEY, data.project.id);
      setSnapshot(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function sendMessage(content: string) {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    // Optimistic user message for snappier feel
    const optimisticId = `temp-${Date.now()}`;
    setSnapshot({
      ...snapshot,
      messages: [
        ...snapshot.messages,
        {
          id: optimisticId,
          conversationId: snapshot.conversation.id,
          projectId: snapshot.project.id,
          role: "user",
          content,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
    });

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to send message");
      }

      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
      await refresh();
    } finally {
      setSending(false);
    }
  }

  async function selectConcept(artworkVersionId: string) {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/select`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artworkVersionId }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to select concept");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to select concept");
    } finally {
      setSending(false);
    }
  }

  async function submitDecision(action: "approve" | "edit" | "continue") {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/brief/decision`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to submit decision");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to submit decision",
      );
    } finally {
      setSending(false);
    }
  }

  /** Sprint 2G Part 3: explicit action, independent of chat — no message required. */
  async function regenerateConcepts() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/concepts/regenerate`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to generate updated concepts");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to generate updated concepts",
      );
    } finally {
      setSending(false);
    }
  }

  /** Sprint 2G Part 3: undoes the most recent accepted revision, if any. */
  async function undoLastChange() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${snapshot.project.id}/undo`, {
        method: "POST",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to undo the last change");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to undo the last change");
    } finally {
      setSending(false);
    }
  }

  async function refresh() {
    if (!snapshot) return;
    const response = await fetch(`/api/projects/${snapshot.project.id}`);
    if (response.ok) {
      setSnapshot((await response.json()) as ApiSnapshot);
    }
  }

  async function startOver() {
    window.localStorage.removeItem(CHAT_PROJECT_STORAGE_KEY);
    setSnapshot(null);
    setLoading(true);
    await bootstrap();
  }

  const phase = snapshot?.conversation.phase;
  const composerDisabled =
    !isClient ||
    loading ||
    sending ||
    !snapshot ||
    phase === "generating" ||
    phase === "skip_references" ||
    phase === "concepts_ready" ||
    phase === "awaiting_summary_confirmation" ||
    phase === "brief_approved";

  const placeholder = useMemo(() => {
    if (!isClient || loading) return "Message iHeartPrints...";
    switch (phase) {
      case "ask_product":
        return "e.g. A T-shirt for our summer camp...";
      case "ask_design":
        return "Describe the artwork you have in mind...";
      case "ask_shirt_color":
        return "e.g. Navy blue";
      case "ask_text":
        return 'Exact text, or "none"';
      case "ask_revisions":
      case "revision_received":
        return "Describe the changes you'd like...";
      case "concepts_ready":
        return "Select a concept above to continue";
      case "generating":
        return "Generating concepts...";
      case "awaiting_summary_confirmation":
        return "Choose Approve, Edit, or Continue above";
      case "brief_approved":
        return "Approved — generating concepts...";
      case "edit_requested":
        return "What would you like to change?";
      case "continue_requested":
        return "Anything else the designer should know?";
      case "interviewing":
        // Sprint 2F: the adaptive engine's actual question is shown in the
        // transcript above; the composer placeholder stays generic.
        return "Message iHeartPrints...";
      default:
        return "Message iHeartPrints...";
    }
  }, [isClient, loading, phase]);

  // Sprint 2G Part 2: a post-approval revision can regenerate concepts,
  // adding a newer batch alongside the old one (never deleting history —
  // Constitution §6.11). Only the batch tied to the most recently approved
  // Design Brief version is "current" and shown to the customer.
  const latestApprovedVersionId = snapshot?.designBriefVersions.at(-1)?.id ?? null;
  const currentArtworkVersions =
    snapshot?.artworkVersions.filter(
      (version) => version.designBriefVersionId === latestApprovedVersionId,
    ) ?? [];

  const showConcepts =
    !!snapshot &&
    currentArtworkVersions.length > 0 &&
    (phase === "concepts_ready" ||
      phase === "ask_revisions" ||
      phase === "revision_received");

  const lastConceptsReadyMessageId = [...(snapshot?.messages ?? [])]
    .reverse()
    .find((message) => message.metadata?.phase === "concepts_ready")?.id;

  const timelineEntries = useMemo(
    () => buildRevisionTimeline(snapshot?.messages ?? []),
    [snapshot?.messages],
  );

  const canUndo = Boolean(snapshot?.conversation.interviewState.lastRevision);

  const showConceptStatusBanner =
    !!snapshot &&
    snapshot.conceptStatus.status === "needs_update" &&
    !conceptBannerDismissed &&
    // Only meaningful once the customer can actually see concepts.
    (phase === "ask_revisions" || phase === "revision_received" || phase === "concepts_ready");

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="mx-auto flex w-full max-w-2xl items-start justify-between gap-4 px-4 pb-2 pt-8">
        <div>
          <div className="flex items-center gap-2.5">
            <LogoMark />
            <h1 className="font-display text-2xl tracking-tight text-ink">
              iHeartPrints
            </h1>
          </div>
          <p className="mt-1 pl-[42px] text-sm text-muted">
            Print-Ready Artwork
          </p>
        </div>
        {isClient && snapshot ? (
          <div className="mt-1 flex items-center gap-3 text-xs">
            {canUndo ? (
              <button
                type="button"
                disabled={sending}
                onClick={() => void undoLastChange()}
                aria-label="Undo the most recent change"
                className="text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                Undo last change
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void startOver()}
              className="text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Start over
            </button>
          </div>
        ) : null}
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pb-4 pt-6">
        {!isClient || loading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            Starting conversation...
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-4" aria-live="polite">
            {snapshot?.messages.map((message, index) => {
              const isLatestMessage = index === snapshot.messages.length - 1;
              const showSummaryCard =
                message.role === "assistant" &&
                message.metadata?.phase === "awaiting_summary_confirmation" &&
                Boolean(message.metadata?.summary) &&
                isLatestMessage &&
                phase === "awaiting_summary_confirmation";
              const showRecommendationCard =
                message.role === "assistant" &&
                message.metadata?.act === "advise" &&
                isLatestMessage &&
                Array.isArray(message.metadata?.actions) &&
                (message.metadata?.actions as unknown[]).length > 0;
              const deferredDecision = message.metadata?.deferredDecision as
                | { section: string; message: string }
                | undefined;

              return (
                <div key={message.id}>
                  <MessageBubble message={message} />
                  {deferredDecision ? (
                    <DesignerDecisionCard message={deferredDecision.message} />
                  ) : null}
                  {showRecommendationCard ? (
                    <RecommendationCard
                      message={message.content}
                      actions={message.metadata!.actions as RecommendationAction[]}
                      busy={sending}
                      onAction={(replyText) => void sendMessage(replyText)}
                    />
                  ) : null}
                  {message.role === "assistant" &&
                  message.metadata?.phase === "concepts_ready" &&
                  message.id === lastConceptsReadyMessageId &&
                  showConcepts ? (
                    <ConceptCards
                      concepts={currentArtworkVersions}
                      projectId={snapshot.project.id}
                      selectedId={snapshot.project.selectedArtworkVersionId}
                      selectable={phase === "concepts_ready"}
                      busy={sending}
                      onSelect={(id) => void selectConcept(id)}
                    />
                  ) : null}
                  {showSummaryCard ? (
                    <DesignSummaryCard
                      summary={message.metadata!.summary as DesignSummaryView}
                      deferredDecisions={
                        message.metadata!.deferredDecisions as
                          | DeferredDecisionView[]
                          | undefined
                      }
                      updatedSections={
                        message.metadata!.updatedSections as
                          | BriefSectionKey[]
                          | undefined
                      }
                      fieldTransitions={
                        message.metadata!.fieldTransitions as
                          | Record<string, FieldTransition>
                          | undefined
                      }
                      busy={sending}
                      onApprove={() => void submitDecision("approve")}
                      onEdit={() => void submitDecision("edit")}
                      onContinue={() => void submitDecision("continue")}
                    />
                  ) : null}
                </div>
              );
            })}

            {(sending || snapshot?.project.status === "generating") &&
            phase !== "concepts_ready" &&
            phase !== "awaiting_summary_confirmation" ? (
              <div className="flex justify-start">
                <div
                  className="rounded-2xl bg-white px-4 py-3 text-sm text-muted shadow-sm ring-1 ring-black/5"
                  aria-label="Generating concepts"
                >
                  <span className="inline-flex gap-1">
                    <span className="animate-pulse">●</span>
                    <span className="animate-pulse [animation-delay:150ms]">
                      ●
                    </span>
                    <span className="animate-pulse [animation-delay:300ms]">
                      ●
                    </span>
                  </span>
                </div>
              </div>
            ) : null}

            {showConceptStatusBanner && snapshot ? (
              <ConceptStatusBanner
                status={snapshot.conceptStatus}
                busy={sending}
                onRegenerate={() => void regenerateConcepts()}
                onKeepCurrent={() => setConceptBannerDismissed(true)}
              />
            ) : null}

            {timelineEntries.length > 1 ? (
              <RevisionTimeline entries={timelineEntries} />
            ) : null}

            {error ? (
              <p className="text-sm text-red-700" role="alert">
                {error}
              </p>
            ) : null}

            <div ref={bottomRef} />
          </div>
        )}
      </main>

      <Composer
        disabled={composerDisabled}
        placeholder={placeholder}
        onSend={sendMessage}
      />
    </div>
  );
}

function LogoMark() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
    >
      <rect width="32" height="32" rx="10" fill="#173F35" />
      <path
        d="M16 23c-.4 0-.7-.1-1-.4l-5.2-5.1c-1.8-1.8-1.8-4.7 0-6.5 1.7-1.7 4.4-1.8 6.2-.3 1.8-1.5 4.5-1.4 6.2.3 1.8 1.8 1.8 4.7 0 6.5L17 22.6c-.3.3-.6.4-1 .4Z"
        fill="#F3EDE4"
      />
    </svg>
  );
}
