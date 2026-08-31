"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BriefSectionKey,
  DeferredDecisionView,
  DesignSummaryView,
  RecommendationAction,
} from "@/capabilities/shared/contracts";
import type { GarmentSizeClass, PrintPlacement } from "@/lib/domain/types";
import { PRODUCTION_BOX_RECOMMENDATIONS } from "@/capabilities/shared/garment-production-sizing";
import type { ApiProjectSnapshot } from "@/lib/services/conversation-service";
import type { ImagePoint } from "./artwork-click-mapping";
import { deriveChatAffordances } from "./chat-affordances";
import { isStalePreparedImageResponse } from "@/capabilities/artwork-preparation";
import {
  deriveUploadedArtworkStep,
  isAtProjectStart,
  uploadedArtworkOwnsSurface,
  type ArtworkTypeChoice,
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
import { EmailContinuationGate } from "./EmailContinuationGate";
import { MessageBubble } from "./MessageBubble";
import { FinalArtworkDeliveryCard } from "./FinalArtworkDeliveryCard";
import { createPaymentConfirmationPoll } from "./payment-confirmation-poll";
import { PrepareForPrintAction } from "./PrepareForPrintAction";
import { ProductionUnlockCard } from "./ProductionUnlockCard";
import { RecommendationCard } from "./RecommendationCard";
import {
  createStatusPollController,
  DEFAULT_STATUS_POLL_INTERVAL_MS,
} from "./status-poll-controller";
import { useIsClient } from "./use-is-client";
import {
  CHECKOUT_RETURN_COMPLETE,
  CHECKOUT_RETURN_PARAM,
  CHECKOUT_START_FAILED_MESSAGE,
  resolveProductionUnlockSurface,
} from "@/capabilities/payment";

type ApiSnapshot = ApiProjectSnapshot & {
  persistenceMode?: "supabase" | "local";
};

export function ChatApp() {
  const isClient = useIsClient();
  const [snapshot, setSnapshot] = useState<ApiSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [preparingForPrint, setPreparingForPrint] = useState(false);
  /**
   * Phase 28H: "Create DTF Halftone Version" is a distinct action from
   * "Create Print-Ready Artwork" — its own in-flight indicator, for the same
   * reason `preparingForPrint` exists (Phase 27M §8): the click's own gap
   * before a response returns must never look identical to nothing having
   * happened.
   */
  const [creatingHalftoneVersion, setCreatingHalftoneVersion] = useState(false);
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
  /**
   * LIVE PRODUCT BLOCKER #1: which artwork path (DTF/apparel or Sign) the
   * customer identified, in the window before either path's own durable
   * signal exists (`printPlacement`, or a `SignPreparation`). Same
   * transient/client-only discipline as `workflowChoice` — see
   * `ArtworkTypeChoice`'s doc in `uploaded-artwork-flow.ts`.
   */
  const [artworkTypeChoice, setArtworkTypeChoice] =
    useState<ArtworkTypeChoice>("undecided");
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
    /** Opaque prepared derivation identity this URL pair belongs to. */
    preparedRevision: string | null;
    original: string | null;
    prepared: string | null;
  }>({
    preparationId: null,
    preparedRevision: null,
    original: null,
    prepared: null,
  });
  const previousConceptStatusRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** Latest prepared revision — used to drop stale signed-URL responses. */
  const preparedRevisionRef = useRef<string | null>(null);

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
  // lightweight finalization status endpoint until it leaves that
  // in-progress state (print_ready / needs_review / retryable_failure /
  // not_requested), then refresh the snapshot once. retryable_failure is
  // terminal for polling — the customer must click Retry Preparation.
  // Never enqueues work and never calls a provider.
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

  // --- Sprint A5.5: the production unlock surface -----------------------
  //
  // Three pieces of LOCAL state, and none of them is payment state. The
  // server owns whether this project is unlocked; these only record what
  // this browser is doing about it.
  const [confirmationTimedOut, setConfirmationTimedOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  /**
   * The checkout return hint, captured ONCE on the first client render.
   *
   * A ref rather than state, and read during render rather than set from an
   * effect. Setting state from an effect body here would trigger a cascading
   * re-render for a value that never changes after the first paint, and the
   * hint has to be captured BEFORE the URL is stripped — so a ref is both the
   * cheaper and the more accurate tool.
   *
   * SSR-safe: the ref stays `null` on the server, so the first paint has no
   * hint and the surface renders from server state alone.
   */
  const checkoutReturnRef = useRef<boolean | null>(null);
  if (isClient && checkoutReturnRef.current === null) {
    checkoutReturnRef.current =
      new URL(window.location.href).searchParams.get(CHECKOUT_RETURN_PARAM) ===
      CHECKOUT_RETURN_COMPLETE;
  }
  const returnedFromCheckout = checkoutReturnRef.current === true;

  /**
   * Strips the hint from the address bar once it has been captured.
   *
   * A genuine external-system update, which is what an effect is for. It
   * matters because the parameter is a ONE-SHOT navigation hint: left in
   * place, a reload or a Back/Forward would keep re-asserting "we just came
   * back from checkout", and somebody who abandoned payment could sit on a
   * confirmation spinner indefinitely.
   *
   * `history.replaceState` rather than a router navigation — this must not
   * add a history entry or re-run the page.
   */
  useEffect(() => {
    if (!isClient) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(CHECKOUT_RETURN_PARAM)) return;
    url.searchParams.delete(CHECKOUT_RETURN_PARAM);
    window.history.replaceState(null, "", url.toString());
  }, [isClient]);
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

  /**
   * Sprint A5.5: start (or resume) a checkout and hand the browser over.
   *
   * The POST carries NO BODY. Amount, currency, production profile, buyer,
   * and email are all resolved server-side (§23d), and the route rejects any
   * property at all — so there is nothing for this function to send even if
   * it wanted to.
   *
   * A double click cannot start two checkouts: the button is disabled while
   * `sending` is true, and beneath that A5.3's outstanding-attempt index
   * makes two concurrent requests converge on ONE payment page.
   */
  async function startProductionUnlockCheckout() {
    if (!snapshot || sending) return;
    setSending(true);
    setCheckoutError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/production-unlock/checkout`,
        { method: "POST" },
      );
      const data = (await response.json()) as {
        checkoutUrl?: string;
        error?: string;
      };

      if (!response.ok || !data.checkoutUrl) {
        // The server's message is already customer-safe and uniform across
        // every internal reason; the local fallback covers a transport
        // failure that produced no body. Neither says "payment failed" —
        // nothing was charged, because nothing was started.
        setCheckoutError(data.error || CHECKOUT_START_FAILED_MESSAGE);
        return;
      }

      // Leaving the app. `assign` rather than `replace` so the browser Back
      // button returns here, which is what a customer who changes their mind
      // on the payment page will reach for.
      window.location.assign(data.checkoutUrl);
    } catch {
      setCheckoutError(CHECKOUT_START_FAILED_MESSAGE);
    } finally {
      setSending(false);
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

  /**
   * Correction A: "Create New Artwork" is a workflow CHOICE, so it posts to
   * the workflow endpoint rather than pretending the customer typed a
   * sentence. There is deliberately no optimistic message: the customer
   * said nothing, and the only thing to render is what the server decides
   * the interview says next.
   */
  async function chooseCreateNewWorkflow() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/workflow`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create_new" }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to start your design");
      }

      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start your design");
      await refresh();
    } finally {
      setSending(false);
    }
  }

  /**
   * Sprint A4: submits the captured email and adopts the refreshed
   * snapshot, so the gate disappears because the SERVER says the state
   * changed — never because the client optimistically hid it.
   *
   * Returns a customer-safe message on failure (rendered by the gate
   * itself) rather than routing through the page-level error banner: a
   * mistyped address belongs next to the input it was typed into.
   */
  async function captureEmail(email: string): Promise<string | null> {
    if (!snapshot) return "Something went wrong";

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/email`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        return typeof data.error === "string"
          ? data.error
          : "We couldn't save that right now. Please try again.";
      }

      setSnapshot(data as ApiSnapshot);
      return null;
    } catch {
      return "We couldn't save that right now. Please try again.";
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
   * Print'em All Phase 1 / Phase 27L: which garment the print is going on.
   *
   * Writes the durable garmentSizeClass and recomputes the suggested box.
   *
   * Phase 27L: when this (garment class, placement) has an authoritative
   * recommendation box, choosing it now ALSO confirms that box in the SAME
   * request (`useRecommended: true`) — bringing this control in line with
   * how `applyProductionPrintWidth` (the width chips / typed width) has
   * always behaved: "an explicit human decision about physical size... is
   * an explicit human decision", confirming immediately rather than
   * waiting for a second, separate click. This was the exact source of the
   * human-observed contradiction (Standard Adult rendered selected while
   * the orange "confirm the print size" copy still showed) — the garment
   * picker was the one control in this surface that didn't confirm on
   * selection, not because a garment category can't determine physical
   * dimensions (it does, deterministically, via
   * `PRODUCTION_BOX_RECOMMENDATIONS`), but because this call simply never
   * asked the (already-supporting) server to confirm it.
   *
   * `custom` has no authoritative box (see `PRODUCTION_BOX_RECOMMENDATIONS`'s
   * own doc: a shipped guess at an unnamed garment would be indistinguishable
   * from a real production decision) -- selecting it must NOT attempt to
   * confirm anything; the width-entry surface (`requiresExplicitWidth`)
   * remains the one honest route forward, exactly as before.
   *
   * Still withdraws any existing (now-stale) confirmation as a side effect
   * of the server applying the new garment class first -- the same
   * "consent named a size on a kind of garment that just changed" rule,
   * just resolved in the same round trip instead of leaving the project
   * briefly unconfirmed.
   */
  async function chooseGarmentSize(garmentSizeClass: GarmentSizeClass) {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    const placement = snapshot.brief.printPlacement;
    const hasRecommendationBox = Boolean(
      placement && PRODUCTION_BOX_RECOMMENDATIONS[garmentSizeClass][placement],
    );

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/print-size/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            hasRecommendationBox
              ? { garmentSizeClass, useRecommended: true }
              : { garmentSizeClass },
          ),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to set the garment size");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to set the garment size",
      );
    } finally {
      setSending(false);
    }
  }

  /**
   * Print'em All Phase 1: "Use recommended size" — records the customer's
   * explicit confirmation of the recommended production box.
   *
   * A separate endpoint from `choosePrintWidth`, deliberately. That one says
   * "make it this wide"; this one says "yes, the area you recommended is
   * right", which is a different statement and — because a box bounds both
   * axes — a different production result for anything that is not square.
   * Confirming is also the fact the server later authorizes paid work
   * against, so it gets its own route rather than riding on a width write.
   */
  /**
   * Phase 28H: "Create DTF Halftone Version" — the OPTIONAL, explicit
   * second-variant action offered once Standard Raster has reached a
   * terminal state (`print_ready` or `needs_attention`/`finalization_required`).
   *
   * Two existing, unmodified routes, called in sequence, exactly the way an
   * internal operator's own two clicks (select the treatment, then request
   * print-ready) already worked in Print'em All Phase 2/3 — this is not a
   * new capability, just the same two steps folded into one customer-facing
   * action with empty `{}` halftone settings (the route/capability already
   * resolve an empty request to the recommended defaults for the garment;
   * see `normalizeHalftoneSettings`). Deliberately ONE combined
   * `sending`/`creatingHalftoneVersion` window across both requests, not two
   * separate ones — releasing `sending` between them would open a real
   * double-submit gap.
   *
   * Never touches Standard Raster: by the time this is reachable at all,
   * Raster's own job has already reached a terminal (`completed`) state —
   * `ApprovedStep`/`PrintReadyPackageCard` only expose this action once that
   * is true — so switching the brief's currently-selected treatment to
   * `halftone_dtf` here cannot supersede/cancel a still-queued Raster job
   * (the stale-intent fence only ever acts on a QUEUED job).
   */
  async function createHalftoneVersion() {
    if (!snapshot || sending) return;
    setSending(true);
    setCreatingHalftoneVersion(true);
    setError(null);

    try {
      const treatmentResponse = await fetch(
        `/api/projects/${snapshot.project.id}/production-treatment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ treatment: "halftone_dtf", halftone: {} }),
        },
      );
      const treatmentData = await treatmentResponse.json();
      if (!treatmentResponse.ok) {
        throw new Error(
          treatmentData.error || "Failed to configure the DTF Halftone version",
        );
      }
      setSnapshot(treatmentData as ApiSnapshot);

      const printReadyResponse = await fetch(
        `/api/projects/${snapshot.project.id}/artwork-preparation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "print_ready" }),
        },
      );
      const printReadyData = await printReadyResponse.json();
      if (!printReadyResponse.ok) {
        throw new Error(
          printReadyData.error || "Failed to create the DTF Halftone version",
        );
      }
      setSnapshot(printReadyData as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Failed to create the DTF Halftone version",
      );
    } finally {
      setSending(false);
      setCreatingHalftoneVersion(false);
    }
  }

  async function confirmRecommendedPrintSize() {
    if (!snapshot || sending) return;
    setSending(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/projects/${snapshot.project.id}/print-size/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ useRecommended: true }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to confirm the print size");
      }
      setSnapshot(data as ApiSnapshot);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to confirm the print size",
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
   * here is always safe. Retry Preparation after `retryable_failure` uses
   * this same POST `/finalize` path — there is no second retry endpoint.
   */
  async function approveFinalDirection() {
    const artworkVersionId = snapshot?.project.selectedArtworkVersionId;
    if (!snapshot || sending || !artworkVersionId) return;
    setSending(true);
    setPreparingForPrint(true);
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
      setPreparingForPrint(false);
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

  /**
   * LIVE PRODUCT BLOCKER #1: the routing answer at `choose_artwork_type`.
   * Client-only, exactly like `onUploadExisting` — nothing durable exists
   * yet to remember this against, so a reload correctly re-asks rather
   * than trapping the customer in a path they never confirmed.
   */
  function chooseArtworkType(choice: "dtf" | "sign") {
    setArtworkTypeChoice(choice);
  }

  /**
   * LIVE PRODUCT BLOCKER #1: the Sign path's one production-context
   * action — bridges the already-uploaded original into the Signs
   * authority (first call only) and records the confirmed ordered size.
   * See `sign-artwork-service.ts`.
   */
  async function confirmSignArtworkSize(input: {
    orderedWidthIn: number;
    orderedHeightIn: number;
  }) {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/sign-artwork`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      "Failed to save your sign size",
    );
  }

  /**
   * LIVE PRODUCT BLOCKER #3: "Check my artwork" — runs the existing Signs
   * inspection/diagnosis/planning capability and shows the translated
   * result. No body: the project has exactly one `SignPreparation`, same
   * no-id-to-forge reasoning as every other action here.
   */
  async function planSignArtwork() {
    if (!snapshot) return;
    await submitPreparationAction(
      () =>
        fetch(`/api/projects/${snapshot.project.id}/sign-artwork/plan`, {
          method: "POST",
        }),
      "Failed to check your artwork",
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
   * Intelligent Separation Phase 10 (Goal 3): `SeparationReviewPanel`
   * approves through its OWN routes, not `submitPreparationAction` — those
   * routes return a `SeparationReviewView`, not a full `ApiSnapshot`, so
   * there is nothing for this component to merge in directly. What
   * `approveSeparationMaster` changes server-side (`preparedAssetId`,
   * project status) is exactly what a full snapshot reload already picks
   * up, so this reuses that existing reload rather than inventing a second,
   * narrower way to patch local state — the same pattern the generation and
   * finalization poll loops above already use.
   */
  async function refreshSnapshotAfterSeparationApproval() {
    if (!snapshot) return;
    const full = await loadProjectSnapshot(snapshot.project.id);
    if (full) setSnapshot(full);
  }

  /**
   * Existing Artwork → Print Ready Phase 1.3: the customer clicked an area to
   * PREVIEW. Sends a COORDINATE only. Nothing is removed until they confirm.
   */
  async function previewGuidedCleanup(
    point: ImagePoint,
    options?: { tool?: "region" | "magic_select"; tolerance?: number },
  ) {
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
            tool: options?.tool ?? "region",
            ...(options?.tool === "magic_select"
              ? { tolerance: options.tolerance }
              : {}),
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
    if (!snapshot || sending) return;
    setPreparingForPrint(true);
    try {
      await submitPreparationAction(
        () =>
          fetch(`/api/projects/${snapshot.project.id}/artwork-preparation`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "print_ready" }),
          }),
        "Failed to prepare your print-ready artwork",
      );
    } finally {
      setPreparingForPrint(false);
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

  const preparation = snapshot?.artworkPreparation ?? null;
  const preparationId = preparation?.preparationId ?? null;
  const hasPreparedArtwork = preparation?.hasPreparedArtwork ?? false;
  /**
   * Phase 1.4: every confirm/undo replaces the prepared derivation. This
   * opaque revision — not removalCount alone — tells the effect below that
   * the signed URL it holds now points at superseded bytes. Preview leaves
   * the revision unchanged, so selecting a second area never reloads (or
   * resurrects) an older automatic/prepared image.
   */
  const preparedRevision = preparation?.preparedRevision ?? null;
  preparedRevisionRef.current = preparedRevision;

  // Existing Artwork → Print Ready Phase 1: mint fresh signed URLs for the
  // original and (once it exists) the prepared image. Keyed on preparation
  // id + preparedRevision so cleanup/undo re-fetches while preview and other
  // unrelated snapshot updates do not.
  useEffect(() => {
    // No preparation means nothing to fetch. State is not cleared here —
    // render reads `preparationId` / `preparedRevision` alongside it, so a
    // stale URL can never be shown for a different derivation.
    if (!isClient || !snapshot || !preparationId) return;

    let cancelled = false;
    const projectId = snapshot.project.id;
    const requestRevision = preparedRevision;

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
      if (cancelled) return;
      if (
        isStalePreparedImageResponse({
          requestRevision,
          authoritativeRevision: preparedRevisionRef.current,
        })
      ) {
        return;
      }
      setPreparationImages({
        preparationId,
        preparedRevision: requestRevision,
        original,
        prepared,
      });
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
    preparedRevision,
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
    // Sprint A4 Correction 2: the server cannot establish what this session
    // may do, so the UI stops offering actions it knows will be refused.
    acquisitionUnavailable: snapshot?.acquisition.state === "unavailable",
  });

  // Existing Artwork → Print Ready Phase 1. The workflow choice is offered
  // only at the very start; once anything is uploaded, the preparation record
  // itself is the durable workflow identity (see `uploaded-artwork-flow.ts`).
  const atProjectStart =
    !!snapshot &&
    isAtProjectStart({
      messages: snapshot.messages,
      artworkVersionCount: snapshot.artworkVersions.length,
    });
  const derivedUploadStep = deriveUploadedArtworkStep({
    preparation,
    signArtwork: snapshot?.signArtwork
      ? {
          specConfirmed: snapshot.signArtwork.specConfirmed,
          hasPlan: snapshot.signArtwork.plan !== null,
        }
      : null,
    choice: workflowChoice,
    artworkTypeChoice,
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
      : { original: null, prepared: null, preparedRevision: null };

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

  const lastConceptsReadyMessage = [...(snapshot?.messages ?? [])]
    .reverse()
    .find((message) => message.metadata?.phase === "concepts_ready");
  const lastConceptsReadyMessageId = lastConceptsReadyMessage?.id;
  const conceptsWithheldRaw = lastConceptsReadyMessage?.metadata?.conceptsWithheld;
  const conceptsWithheld =
    typeof conceptsWithheldRaw === "number" && conceptsWithheldRaw > 0
      ? conceptsWithheldRaw
      : null;
  const garmentPreviewInput = snapshot?.brief
    ? {
        shirtColor: snapshot.brief.shirtColor,
        deferredSections: snapshot.brief.deferredSections,
        productSummary: snapshot.brief.productSummary,
        designDescription: snapshot.brief.designDescription,
      }
    : null;

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

  // Sprint A5.5: THE ONE PLACE a payment view becomes something to render.
  // Resolved by the shared pure rule, never re-derived here — and note that
  // `returnedFromCheckout` cannot reach `production_unlocked` through it.
  const unlockSurface = snapshot
    ? resolveProductionUnlockSurface({
        payment: snapshot.payment,
        returnedFromCheckout,
      })
    : "none";

  /**
   * Bounded confirmation polling.
   *
   * Runs ONLY while the surface is `payment_processing`, which requires both
   * a durable outstanding attempt and the one-shot return hint — so an
   * abandoned checkout never polls, and a customer who never opened checkout
   * never polls.
   *
   * The first check fires immediately, because a webhook that landed before
   * the browser returned is the common case and there is no reason to show a
   * spinner for an interval before discovering the project is already
   * unlocked.
   */
  useEffect(() => {
    if (!isClient || unlockSurface !== "payment_processing") return;
    const projectId = snapshot?.project.id;
    if (!projectId) return;

    return createPaymentConfirmationPoll({
      refreshAndCheckUnlocked: async () => {
        const response = await fetch(`/api/projects/${projectId}`);
        if (!response.ok) return false;
        const fresh = (await response.json()) as ApiSnapshot;
        setSnapshot(fresh);
        // AUTHORITATIVE. The entitlement is the only thing that stops the
        // poll — never the transaction status, and never the fact that we
        // came back from a payment page.
        return fresh.payment.state === "production_unlocked";
      },
      onTimeout: () => setConfirmationTimedOut(true),
    }).start();
  }, [isClient, unlockSurface, snapshot?.project.id]);
  // Sprint A4: the email continuation gate. Purely a mirror of a
  // server-derived state — the client never decides that a gate applies,
  // and the server refuses the same actions whether or not this renders.
  const showEmailGate = snapshot?.acquisition.state === "email_required";
  // Sprint A4 Correction 1: `unavailable` is shown with the same quiet note
  // as `continue_locked`, deliberately. Both mean "not right now"; neither is
  // the customer's fault; neither says anything about why.
  //
  // Sprint A5.5: SUPPRESSED whenever a commercial surface is showing. The
  // `continue_locked` sentence ("...aren't available on your session yet —
  // we'll let you know...") is still true of GENERATION, which A5.5 does not
  // unlock, but stacking it above a card asking for money is exactly the
  // duplicated-commercial-message friction this sprint exists to avoid: two
  // surfaces telling the customer different stories about the same moment.
  // The card is the commercial authority; the note stays for the states
  // where there is no card (nothing purchasable, or unresolvable authority).
  const acquisitionNotice =
    unlockSurface === "none" &&
    (snapshot?.acquisition.state === "continue_locked" ||
      snapshot?.acquisition.state === "unavailable")
      ? snapshot.acquisition.message
      : null;

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
                      garmentPreviewInput={garmentPreviewInput}
                      conceptsWithheld={conceptsWithheld}
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

            {/* Existing Artwork → Print Ready Phase 1. The two sides of this
                card are not symmetric, because the two answers are not.
                "Upload Existing Artwork" opens a workflow whose identity
                becomes durable the moment a file is uploaded, so it is a
                client step until then. "Create New Artwork" is an answer to
                the question already on screen, so it is submitted as one —
                through the same path as every other customer turn. Sending
                it is also what dismisses this card, because the reply then
                exists server-side and `atProjectStart` is no longer true:
                the card goes away because the conversation moved, never
                because the client optimistically hid it. */}
            {uploadedArtworkStep === "choose_workflow" ? (
              <WorkflowChoiceCard
                busy={sending}
                onCreateNew={() => void chooseCreateNewWorkflow()}
                onUploadExisting={() => setWorkflowChoice("upload_existing")}
              />
            ) : null}

            {uploadedArtworkStep && uploadedArtworkStep !== "choose_workflow" ? (
              <UploadedArtworkPanel
                // `preparation` truthy (required to even reach the "compare"
                // step this id feeds) implies `snapshot` is truthy too, since
                // `preparation` is derived from it — but TS can't see that
                // cross-variable link, so this mirrors the same `snapshot?.`
                // guard used for every other snapshot-derived prop here.
                projectId={snapshot?.project.id ?? ""}
                step={uploadedArtworkStep}
                preparation={preparation}
                busy={sending}
                originalImageUrl={currentPreparationImages.original}
                preparedImageUrl={currentPreparationImages.prepared}
                preparedRevision={
                  // Prefer the URL's bound revision while a newer fetch is in
                  // flight so the workspace keeps showing the last authoritative
                  // prepared bytes (e.g. post-D while post-D+R loads) instead of
                  // flashing empty. Snapshot revision is still what triggers fetch.
                  currentPreparationImages.preparedRevision ?? preparedRevision
                }
                onUpload={(file) => void uploadExistingArtwork(file)}
                onChooseArtworkType={(choice) => chooseArtworkType(choice)}
                onConfirmSignSize={(input) => void confirmSignArtworkSize(input)}
                onPlanSignArtwork={() => void planSignArtwork()}
                signArtwork={snapshot?.signArtwork ?? null}
                onSaveDetails={(input) => void saveUploadedArtworkDetails(input)}
                onPrepare={() => void prepareUploadedArtwork()}
                onApprove={() => void approvePreparedArtwork()}
                onSeparationApproved={() => void refreshSnapshotAfterSeparationApproval()}
                onReconsider={() => setReconsideringUpload(true)}
                onCleanupPoint={(point, options) =>
                  void previewGuidedCleanup(point, options)
                }
                onConfirmCleanup={() => void confirmGuidedCleanup()}
                onCancelCleanupPreview={cancelGuidedCleanupPreview}
                onUndoCleanup={() => void undoGuidedCleanup()}
                cleanupMessage={cleanupMessage}
                cleanupPreviewHighlight={cleanupPreview?.highlight ?? null}
                printReadySize={snapshot?.printReadySize ?? null}
                onChoosePrintWidth={(widthIn) => void choosePrintWidth(widthIn)}
                onUseRecommendedSize={() => void confirmRecommendedPrintSize()}
                onChooseGarmentSize={(garmentSizeClass) =>
                  void chooseGarmentSize(garmentSizeClass)
                }
                finalizationStatus={snapshot?.finalization.status ?? "not_requested"}
                onPrepareForPrint={() => void prepareUploadedArtworkForPrint()}
                preparingForPrint={preparingForPrint}
                printReadyPackage={snapshot?.printReadyPackage}
                onCreateHalftoneVersion={() => void createHalftoneVersion()}
                creatingHalftoneVersion={creatingHalftoneVersion}
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

            {/* Sprint A4: shown after the free concept, never before it —
                the customer sees what they were promised first, then is
                asked for an address to keep going. */}
            {showEmailGate && snapshot ? (
              <EmailContinuationGate
                busy={sending}
                onSubmit={(email) => captureEmail(email)}
              />
            ) : null}

            {/* Address already given; further design work needs access this
                product does not sell yet. A quiet note, not an error —
                nothing has gone wrong. */}
            {acquisitionNotice ? (
              <p className="mt-3 rounded-2xl border border-black/8 bg-white p-4 text-sm text-muted shadow-sm">
                {acquisitionNotice}
              </p>
            ) : null}

            {/* Sprint A5.5: the commercial surface. Rendered AFTER the email
                gate and BEFORE the finalization action, which is the order
                the customer actually moves through: give an address, choose
                a design, unlock it, then prepare it. Payment state lives
                here and nowhere in the transcript. */}
            {snapshot ? (
              <ProductionUnlockCard
                surface={unlockSurface}
                offer={snapshot.payment.offer}
                busy={sending}
                confirmationTimedOut={confirmationTimedOut}
                errorMessage={checkoutError}
                onUnlock={() => void startProductionUnlockCheckout()}
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
                preparing={preparingForPrint}
                onPrepare={() => void approveFinalDirection()}
                printReadySize={snapshot.printReadySize}
                onChoosePrintWidth={(widthIn) => void choosePrintWidth(widthIn)}
                onUseRecommendedSize={() => void confirmRecommendedPrintSize()}
                onChooseGarmentSize={(garmentSizeClass) =>
                  void chooseGarmentSize(garmentSizeClass)
                }
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
                garmentPreviewInput={garmentPreviewInput}
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
