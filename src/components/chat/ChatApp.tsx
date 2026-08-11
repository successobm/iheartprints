"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BriefSectionKey,
  DeferredDecisionView,
  DesignSummaryView,
  RecommendationAction,
} from "@/capabilities/shared/contracts";
import type { PrintPlacement } from "@/lib/domain/types";
import type { ApiProjectSnapshot } from "@/lib/services/conversation-service";
import type { ImagePoint } from "./artwork-click-mapping";
import { deriveChatAffordances } from "./chat-affordances";
import {
  deriveUploadedArtworkStep,
  uploadedArtworkOwnsSurface,
  type WorkflowChoice,
} from "./uploaded-artwork-flow";
import { UploadedArtworkPanel } from "./UploadedArtworkPanel";
import { WorkflowChoiceCard } from "./WorkflowChoiceCard";
import {
  CHAT_PROJECT_STORAGE_KEY,
  planSessionBootstrap,
} from "./chat-session";
import { Composer } from "./Composer";
import { ConceptCards } from "./ConceptCards";
import { ConceptStatusBanner } from "./ConceptStatusBanner";
import { DesignerDecisionCard } from "./DesignerDecisionCard";
import { buildDesignHistory } from "./design-history";
import { DesignHistory } from "./DesignHistory";
import { DesignSummaryCard, type FieldTransition } from "./DesignSummaryCard";
import { MessageBubble } from "./MessageBubble";
import { FinalArtworkDeliveryCard } from "./FinalArtworkDeliveryCard";
import { PrepareForPrintAction } from "./PrepareForPrintAction";
import { RecommendationCard } from "./RecommendationCard";
import {
  createStatusPollController,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
} from "./status-poll-controller";
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
  /**
   * Client-only delivery-mode reopen. Does not supersede the completed
   * final approval by itself — that still happens only when the customer
   * submits a real revision through the existing lifecycle.
   */
  const [deliveryEditingReopened, setDeliveryEditingReopened] = useState(false);
  /**
   * Existing Artwork → Print Ready Phase 1. Transient by design: only the
   * window BEFORE anything has been uploaded needs it, and there is nothing
   * durable to remember yet. A reload correctly returns the customer to the
   * choice rather than trapping them in a workflow they never committed to —
   * see `uploaded-artwork-flow.ts`.
   */
  const [workflowChoice, setWorkflowChoice] = useState<WorkflowChoice>("undecided");
  /** Client-only "take me back a step" from the comparison/analysis surface. */
  const [reconsideringUpload, setReconsideringUpload] = useState(false);
  /**
   * Phase 1.2 / 1.3: the server's already-phrased answer to the LAST cleanup
   * action. Transient by design — it describes one action, not the project,
   * so it is never persisted and is cleared by any other action.
   */
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);
  /**
   * Phase 1.3: pending preview awaiting confirmation. Ephemeral React state
   * only — a reload discards it, which is intentional.
   */
  const [cleanupPreview, setCleanupPreview] = useState<{
    candidateToken: string;
    highlight: {
      bounds: {
        left: number;
        top: number;
        right: number;
        bottom: number;
        width: number;
        height: number;
      };
      overlayDataUrl: string;
    };
  } | null>(null);
  /**
   * Signed URLs are tagged with the preparation they belong to, so a stale
   * URL can never be rendered against a different (or absent) preparation —
   * the alternative, clearing state from inside the fetch effect, is a
   * cascading-render pattern React explicitly warns against.
   */
  const [preparationImages, setPreparationImages] = useState<{
    preparationId: string | null;
    original: string | null;
    prepared: string | null;
  }>({ preparationId: null, original: null, prepared: null });
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

  // Sprint 2H Part 2A: concept generation runs in the background — while
  // the project is "generating", poll a lightweight status endpoint (never
  // the full snapshot) until it flips, then refresh once for the real
  // result. Same controller as finalization polling below.
  useEffect(() => {
    if (!isClient || !snapshot || snapshot.project.status !== "generating") {
      return;
    }

    const projectId = snapshot.project.id;
    return createStatusPollController({
      inProgressStatus: "generating",
      intervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
      pollStatus: () =>
        pollProjectStatus(`/api/projects/${projectId}/generation/status`),
      refreshSnapshot: async () => {
        const full = await loadProjectSnapshot(projectId);
        if (!full) throw new Error("Failed to refresh project snapshot");
        setSnapshot(full);
      },
    }).start();
    // Deliberately scoped to just status/id, not the whole snapshot object
    // — restarting this interval on every unrelated snapshot update (a new
    // message, a summary edit, ...) would fight the polling cadence below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient, snapshot?.project.status, snapshot?.project.id]);

  // While customer-safe finalization status is "preparing", poll the
  // lightweight finalization status endpoint until it reaches a terminal
  // customer state (print_ready / needs_review / not_requested), then
  // refresh the snapshot once. Never enqueues work and never calls a
  // provider — same read-only contract as generation status polling.
  useEffect(() => {
    if (!isClient || !snapshot || snapshot.finalization.status !== "preparing") {
      return;
    }

    const projectId = snapshot.project.id;
    return createStatusPollController({
      inProgressStatus: "preparing",
      intervalMs: DEFAULT_STATUS_POLL_INTERVAL_MS,
      pollStatus: () =>
        pollProjectStatus(`/api/projects/${projectId}/finalization/status`),
      refreshSnapshot: async () => {
        const full = await loadProjectSnapshot(projectId);
        if (!full) throw new Error("Failed to refresh project snapshot");
        setSnapshot(full);
      },
    }).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isClient, snapshot?.finalization.status, snapshot?.project.id]);

  // Leaving print_ready clears the local reopen flag so a later delivery
  // cycle starts clean. Adjust during render (React-supported props→state
  // sync) — an effect here trips react-hooks/set-state-in-effect.
  const finalizationStatusForDelivery =
    snapshot?.finalization.status ?? "not_requested";
  if (
    finalizationStatusForDelivery !== "print_ready" &&
    deliveryEditingReopened
  ) {
    setDeliveryEditingReopened(false);
  }

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

  async function submitDecision(action: "approve" | "edit") {
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

  /**
   * Live Acceptance Cleanup (Issue 2): explicit "Change Selection". The
   * server owns the state change — this never clears anything locally, so a
   * failed request leaves the real selection intact rather than showing a
   * selection the server doesn't have.
   */
  async function unselectConcept() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/unselect`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to change your selection");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to change your selection",
      );
    } finally {
      setSending(false);
    }
  }

  /** Live Acceptance Cleanup (Issue 3): "Show Me 3 New Concepts". */
  async function exploreNewConcepts() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/concepts/explore`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to explore new concepts");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to explore new concepts",
      );
    } finally {
      setSending(false);
    }
  }

  /**
   * Live Acceptance Cleanup (Issue 5): production-size change only. Never
   * touches the artwork — see `ConversationCapability.setProductionPrintWidth`.
   */
  async function choosePrintWidth(widthIn: number) {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/print-size`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ widthIn }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to set the print size");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set the print size",
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

  /**
   * Live Acceptance Corrective Pass (Section 2): the customer's explicit
   * "no more changes, use this design" confirmation — independent of
   * chat, same shape as `selectConcept`. Distinct from, and a
   * prerequisite for, `approveFinalDirection` below.
   */
  async function confirmSelectedDirection() {
    const artworkVersionId = snapshot?.project.selectedArtworkVersionId;
    if (!snapshot || sending || !artworkVersionId) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/confirm-direction`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artworkVersionId }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to confirm this direction");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm this direction");
    } finally {
      setSending(false);
    }
  }

  /**
   * Sprint 2M Phase 2B: the customer's explicit "this is my final direction"
   * action — independent of chat, same shape as `selectConcept`/
   * `regenerateConcepts`. Idempotent server-side, so a stray double click
   * here is always safe.
   */
  async function approveFinalDirection() {
    const artworkVersionId = snapshot?.project.selectedArtworkVersionId;
    if (!snapshot || sending || !artworkVersionId) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/finalize`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artworkVersionId }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to prepare print-ready artwork");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to prepare print-ready artwork",
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

  /**
   * Existing Artwork → Print Ready Phase 1: the explicit actions in the Upload
   * Existing Artwork flow. All go through the same request shape as every
   * other action in this component and all are idempotent server-side, so a
   * double click is always safe.
   */
  async function submitPreparationAction(
    request: () => Promise<Response>,
    failureMessage: string,
    options?: { preserveCleanupPreview?: boolean },
  ) {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await request();
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || failureMessage);
      setReconsideringUpload(false);
      setSnapshot(data as ApiSnapshot);
      // Phase 1.2 / 1.3: the server's answer to a cleanup action, including
      // refusals, travels beside the snapshot rather than in it. Cleared on
      // every other action so a stale "we left that unchanged" can never
      // linger over an unrelated step.
      const cleanup = (
        data as {
          cleanup?: {
            message?: string;
            outcome?: string;
            candidateToken?: string;
            highlight?: {
              bounds: {
                left: number;
                top: number;
                right: number;
                bottom: number;
                width: number;
                height: number;
              };
              overlayDataUrl: string;
            };
          };
        }
      ).cleanup;
      setCleanupMessage(
        typeof cleanup?.message === "string" ? cleanup.message : null,
      );
      if (!options?.preserveCleanupPreview) {
        if (
          cleanup?.outcome === "preview" &&
          typeof cleanup.candidateToken === "string" &&
          cleanup.highlight
        ) {
          setCleanupPreview({
            candidateToken: cleanup.candidateToken,
            highlight: cleanup.highlight,
          });
        } else {
          setCleanupPreview(null);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : failureMessage);
    } finally {
      setSending(false);
    }
  }

  async function uploadExistingArtwork(file: File) {
    if (!snapshot) return;
    const body = new FormData();
    body.append("file", file);
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-upload`, {
          method: "POST",
          body,
        }),
      "We couldn't accept that upload. Please try again.",
    );
  }

  async function saveUploadedArtworkDetails(input: {
    productSummary: string | null;
    productColor: string | null;
    printPlacement: PrintPlacement | null;
  }) {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "context", ...input }),
        }),
      "Failed to save those details",
    );
  }

  async function prepareUploadedArtwork() {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "prepare" }),
        }),
      "Failed to prepare your artwork",
    );
  }

  async function approvePreparedArtwork() {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve" }),
        }),
      "Failed to approve your prepared artwork",
    );
  }

  /**
   * Existing Artwork → Print Ready Phase 1.3: the customer clicked an area to
   * PREVIEW. Sends a COORDINATE only. Nothing is removed until they confirm.
   */
  async function previewGuidedCleanup(point: ImagePoint) {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cleanup_preview",
            x: point.x,
            y: point.y,
          }),
        }),
      "We couldn't preview that area. Please try again.",
    );
  }

  async function confirmGuidedCleanup() {
    if (!snapshot || !cleanupPreview) return;
    const token = cleanupPreview.candidateToken;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cleanup_confirm",
            candidateToken: token,
          }),
        }),
      "We couldn't remove that area. Please try again.",
    );
  }

  function cancelGuidedCleanupPreview() {
    setCleanupPreview(null);
    setCleanupMessage(null);
  }

  async function undoGuidedCleanup() {
    if (!snapshot) return;
    setCleanupPreview(null);
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "undo_cleanup" }),
        }),
      "We couldn't undo that. Please try again.",
    );
  }

  /**
   * Existing Artwork → Print Ready Phase 2: the upload workflow's "Prepare
   * Print-Ready Artwork". Idempotent server-side on (approved preparation,
   * production size), so a double click, a reload, or a second tab can never
   * start a second run — or a second paid one.
   */
  async function prepareUploadedArtworkForPrint() {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "print_ready" }),
        }),
      "Failed to prepare your print-ready artwork",
    );
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

  const preparation = snapshot?.artworkPreparation ?? null;
  const preparationId = preparation?.preparationId ?? null;
  const hasPreparedArtwork = preparation?.hasPreparedArtwork ?? false;
  /**
   * Phase 1.2: every accepted guided removal (and every undo) replaces the
   * prepared asset, so this count is what tells the effect below that the
   * signed URL it holds now points at superseded bytes. Without it the
   * customer would click, the server would do the work, and the preview would
   * not change — which reads exactly like the click was ignored.
   *
   * A REFUSED click leaves the count alone, which is correct: nothing was
   * derived, so there is nothing new to fetch.
   */
  const guidedCleanupCount = preparation?.guidedCleanup.removalCount ?? 0;

  // Existing Artwork → Print Ready Phase 1: mint fresh signed URLs for the
  // original and (once it exists) the prepared image. Keyed on the
  // preparation id, whether a prepared asset exists, and how many guided
  // removals produced it — so approving, re-preparing, or cleaning up
  // re-fetches while unrelated snapshot updates do not.
  useEffect(() => {
    // No preparation means nothing to fetch. State is not cleared here —
    // render reads `preparationId` alongside it (see `preparationImagesFor`),
    // so a stale URL can never be shown for a different preparation.
    if (!isClient || !snapshot || !preparationId) return;

    let cancelled = false;
    const projectId = snapshot.project.id;

    async function loadImageUrl(role: "original" | "prepared") {
      const response = await fetch(
        `/api/projects/${projectId}/artwork-preparation/image/${role}`,
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { url?: string };
      return typeof data.url === "string" ? data.url : null;
    }

    void (async () => {
      const [original, prepared] = await Promise.all([
        loadImageUrl("original").catch(() => null),
        hasPreparedArtwork ? loadImageUrl("prepared").catch(() => null) : null,
      ]);
      if (!cancelled) {
        setPreparationImages({ preparationId, original, prepared });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isClient,
    snapshot?.project.id,
    preparationId,
    hasPreparedArtwork,
    guidedCleanupCount,
  ]);

  const phase = snapshot?.conversation.phase;
  const affordances = deriveChatAffordances({
    phase,
    ready: isClient && !loading && !!snapshot,
    busy: sending,
    selectedArtworkVersionId: snapshot?.project.selectedArtworkVersionId ?? null,
    revisionPending: snapshot?.project.revisionPending ?? false,
    finalDirectionConfirmed: snapshot?.project.finalDirectionConfirmed ?? false,
    conceptsNeedUpdate: snapshot?.conceptStatus.status === "needs_update",
    finalizationRequested: snapshot?.finalization.status !== "not_requested",
    finalizationStatus: snapshot?.finalization.status ?? "not_requested",
    deliveryEditingReopened,
  });

  // Existing Artwork → Print Ready Phase 1. The workflow choice is offered
  // only at the very start; once anything is uploaded, the preparation record
  // itself is the durable workflow identity (see `uploaded-artwork-flow.ts`).
  const atProjectStart =
    !!snapshot &&
    snapshot.messages.every((message) => message.role !== "user") &&
    snapshot.artworkVersions.length === 0;
  const derivedUploadStep = deriveUploadedArtworkStep({
    preparation,
    choice: workflowChoice,
    atProjectStart,
  });
  // "Change these details" / "Keep my original for now" step back without
  // discarding anything the server already holds.
  const uploadedArtworkStep =
    reconsideringUpload &&
    derivedUploadStep !== null &&
    derivedUploadStep !== "approved" &&
    derivedUploadStep !== "choose_workflow" &&
    derivedUploadStep !== "upload"
      ? "confirm_details"
      : derivedUploadStep;
  const uploadedArtworkActive = uploadedArtworkOwnsSurface(uploadedArtworkStep);
  const currentPreparationImages =
    preparationId !== null && preparationImages.preparationId === preparationId
      ? preparationImages
      : { original: null, prepared: null };

  // An uploaded-artwork customer already has their design: the creative
  // surfaces (concept grid, summary card, revision actions, composer) are
  // hidden rather than merely unreachable, so they are never walked through a
  // design description, three directions, or a wording interview.
  const composerDisabled = affordances.composerDisabled || uploadedArtworkActive;

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
        return "Choose Approve or Edit above";
      case "brief_approved":
        return "Approved — generating concepts...";
      case "edit_requested":
        return "What would you like to change or add?";
      // Sprint 2L Phase 1B (Goal 12): "continue_requested" is no longer
      // reachable from the Design Summary (the Continue button was
      // removed as redundant with Edit) — this case is kept only so a
      // historical project still sitting in that phase renders a sensible
      // placeholder rather than falling through to the generic default.
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
  // Constitution §6.11).
  //
  // Live Acceptance Cleanup (Issue 3): "which concepts are current" is no
  // longer a filter this component can perform, because one approved brief
  // version may now own more than one batch ("Show Me 3 New Concepts"
  // explores again without changing the brief). The server already computes
  // it — reuse that rather than re-deriving batch identity client-side from
  // fields the customer projection deliberately strips.
  const currentArtworkVersions = snapshot?.conceptStatus.currentConcepts ?? [];

  const showConcepts =
    currentArtworkVersions.length > 0 &&
    affordances.showArtworkSurfaces &&
    !uploadedArtworkActive;

  const lastConceptsReadyMessageId = [...(snapshot?.messages ?? [])]
    .reverse()
    .find((message) => message.metadata?.phase === "concepts_ready")?.id;

  // Live Acceptance Corrective Pass (Section 2): one artwork-version-
  // lineage-based history, replacing the old message-metadata-keyed
  // timeline (which surfaced brief-field-only edits like "Changed Print
  // Location" as if they were design milestones) and the separate
  // "View design history" panel — see `design-history.ts`.
  const designHistoryEntries = useMemo(
    () =>
      buildDesignHistory(
        snapshot?.artworkVersions ?? [],
        snapshot?.project.selectedArtworkVersionId ?? null,
      ),
    [snapshot?.artworkVersions, snapshot?.project.selectedArtworkVersionId],
  );

  const canUndo = Boolean(snapshot?.conversation.interviewState.lastRevision);

  const showConceptStatusBanner =
    !!snapshot &&
    snapshot.conceptStatus.status === "needs_update" &&
    !conceptBannerDismissed &&
    // Only meaningful once the customer can actually see concepts.
    affordances.showArtworkSurfaces &&
    !uploadedArtworkActive;

  // Sprint 2M Phase 2B: same "concepts are visible" gate as the
  // concept-status banner above — a selected, current concept can be
  // approved for production once the customer is done revising it.
  // Phase 1 deliberately stops at approved prepared artwork: production
  // finalization for uploaded artwork is Phase 2's, so the Prepare
  // Print-Ready action stays out of this workflow entirely rather than
  // appearing and doing something only half-wired.
  const showFinalizeAction =
    affordances.showArtworkSurfaces && !uploadedArtworkActive;
  const canRequestFinalArtwork = affordances.canRequestFinalArtwork;
  const showUseThisDesignAction =
    affordances.showUseThisDesign && !uploadedArtworkActive;

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
                  {/* Sprint 2L Phase 1B (Goal 13): the structured
                      DesignSummaryCard below is authoritative and renders
                      every field this prose message would otherwise repeat
                      — showing both is pure duplication for the one turn
                      it's interactive. Once this message is no longer the
                      latest (summary card no longer shown), the prose
                      bubble renders normally as the durable transcript
                      record, so conversation history is never lost. */}
                  {!showSummaryCard ? <MessageBubble message={message} /> : null}
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
                    />
                  ) : null}
                </div>
              );
            })}

            {/* Existing Artwork → Print Ready Phase 1. The choice card is a
                pure client-side branch: picking "Create New Artwork" only
                dismisses it, so the existing interview is byte-for-byte
                unchanged for every customer who does not upload anything. */}
            {uploadedArtworkStep === "choose_workflow" ? (
              <WorkflowChoiceCard
                busy={sending}
                onCreateNew={() => setWorkflowChoice("create_new")}
                onUploadExisting={() => setWorkflowChoice("upload_existing")}
              />
            ) : null}

            {uploadedArtworkStep && uploadedArtworkStep !== "choose_workflow" ? (
              <UploadedArtworkPanel
                step={uploadedArtworkStep}
                preparation={preparation}
                busy={sending}
                originalImageUrl={currentPreparationImages.original}
                preparedImageUrl={currentPreparationImages.prepared}
                onUpload={(file) => void uploadExistingArtwork(file)}
                onSaveDetails={(input) => void saveUploadedArtworkDetails(input)}
                onPrepare={() => void prepareUploadedArtwork()}
                onApprove={() => void approvePreparedArtwork()}
                onReconsider={() => setReconsideringUpload(true)}
                onCleanupPoint={(point) => void previewGuidedCleanup(point)}
                onConfirmCleanup={() => void confirmGuidedCleanup()}
                onCancelCleanupPreview={cancelGuidedCleanupPreview}
                onUndoCleanup={() => void undoGuidedCleanup()}
                cleanupMessage={cleanupMessage}
                cleanupPreviewHighlight={cleanupPreview?.highlight ?? null}
                printReadySize={snapshot?.printReadySize ?? null}
                onChoosePrintWidth={(widthIn) => void choosePrintWidth(widthIn)}
                finalizationStatus={snapshot?.finalization.status ?? "not_requested"}
                onPrepareForPrint={() => void prepareUploadedArtworkForPrint()}
              />
            ) : null}

            {(sending || snapshot?.project.status === "generating") &&
            !uploadedArtworkActive &&
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

            {showUseThisDesignAction ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/8 bg-white p-4 shadow-sm">
                <p className="text-sm text-ink">
                  Any changes you&apos;d like, or is this the one?
                </p>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => void confirmSelectedDirection()}
                  className="shrink-0 rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Use This Design
                </button>
              </div>
            ) : null}

            {/* Live Acceptance Cleanup (Issues 2 & 3): the two ways out of
                "I don't want to go forward with this" that are not Start
                Over — change which concept is selected, or ask for three
                genuinely different directions from the same brief. Both are
                quiet secondary actions: neither should compete with Use
                This Design for attention. */}
            {!uploadedArtworkActive &&
            (affordances.showChangeSelection ||
              affordances.showExploreNewConcepts) ? (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {affordances.showChangeSelection ? (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => void unselectConcept()}
                    className="text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Change Selection
                  </button>
                ) : null}
                {affordances.showExploreNewConcepts ? (
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => void exploreNewConcepts()}
                    className="text-muted underline-offset-2 hover:text-ink hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Show Me 3 New Concepts
                  </button>
                ) : null}
              </div>
            ) : null}

            {showFinalizeAction &&
            snapshot &&
            snapshot.finalization.status !== "print_ready" ? (
              <PrepareForPrintAction
                finalizationStatus={snapshot.finalization.status}
                canRequest={canRequestFinalArtwork}
                busy={sending}
                onPrepare={() => void approveFinalDirection()}
                printReadySize={snapshot.printReadySize}
                onChoosePrintWidth={(widthIn) => void choosePrintWidth(widthIn)}
              />
            ) : null}

            {affordances.showDeliveryCard && snapshot ? (
              <FinalArtworkDeliveryCard
                projectId={snapshot.project.id}
                onMakeAnotherChange={() => setDeliveryEditingReopened(true)}
                showMakeAnotherChange={!uploadedArtworkActive}
              />
            ) : null}

            {snapshot?.finalization.status === "print_ready" &&
            !uploadedArtworkActive &&
            deliveryEditingReopened ? (
              <div className="mt-3 rounded-2xl border border-black/8 bg-white p-4 text-sm text-ink shadow-sm">
                Describe the change you&apos;d like to make.
              </div>
            ) : null}

            {snapshot && !uploadedArtworkActive ? (
              <DesignHistory
                entries={designHistoryEntries}
                artworkVersions={snapshot.artworkVersions}
                projectId={snapshot.project.id}
                selectedId={snapshot.project.selectedArtworkVersionId}
                selectable={
                  !affordances.hideComposer &&
                  (phase === "ask_revisions" || phase === "revision_received")
                }
                busy={sending}
                onSelect={(id) => void selectConcept(id)}
              />
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

      {!affordances.hideComposer && !uploadedArtworkActive ? (
        <Composer
          disabled={composerDisabled}
          placeholder={placeholder}
          onSend={sendMessage}
        />
      ) : null}
    </div>
  );
}

async function pollProjectStatus(url: string): Promise<string | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to poll ${url}`);
  const data = (await response.json()) as { status?: string };
  if (typeof data.status !== "string") {
    throw new Error(`Invalid status payload from ${url}`);
  }
  return data.status;
}

async function loadProjectSnapshot(projectId: string): Promise<ApiSnapshot | null> {
  const response = await fetch(`/api/projects/${projectId}`);
  if (!response.ok) return null;
  return (await response.json()) as ApiSnapshot;
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
