"use client";

import { useEffect, useState } from "react";

import { formatProductionArtworkMetadataLine } from "./final-artwork-delivery-metadata";

export interface ProductionArtworkClientView {
  url: string;
  filename: string;
  mimeType: string;
  widthPx: number | null;
  heightPx: number | null;
  transparent: boolean | null;
  placementLabel: string | null;
  designLabel: string | null;
  /**
   * Live Acceptance Cleanup (Issue 5): the size this plate was actually
   * produced at — the customer's chosen width, never a default.
   */
  widthIn: number | null;
  heightIn: number | null;
  dpi: number | null;
}

export type DeliveryLoadState =
  | { status: "loading" }
  | { status: "ready"; artwork: ProductionArtworkClientView }
  | { status: "error" };

interface FinalArtworkDeliveryCardProps {
  projectId: string;
  onMakeAnotherChange: () => void;
  /**
   * Existing Artwork → Print Ready Phase 2: `false` for the upload workflow.
   * "Make Another Change" reopens the creative revision loop, and an upload
   * customer has none — their design was finished before they arrived, and the
   * only change still available to them (production size) lives on the
   * uploaded-artwork panel. Offering it here would be a button leading
   * nowhere.
   */
  showMakeAnotherChange?: boolean;
  /**
   * Test-only injectors — production always fetches the live route.
   */
  fetchProductionArtwork?: (
    projectId: string,
  ) => Promise<ProductionArtworkClientView | null>;
  /**
   * Test-only: skip the mount fetch and render a fixed load state
   * (SSR-friendly coverage for ready / error / loading shells).
   */
  forcedLoadState?: DeliveryLoadState;
}

const CHECKERBOARD_STYLE = {
  backgroundImage:
    "linear-gradient(45deg, #e5e5e5 25%, transparent 25%), linear-gradient(-45deg, #e5e5e5 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e5e5e5 75%), linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)",
  backgroundSize: "20px 20px",
  backgroundPosition: "0 0, 0 10px, 10px -10px, -10px 0px",
  backgroundColor: "#f7f7f5",
} as const;

/**
 * Delivery-mode surface once `PrintProject.status === "print_ready"`.
 * Shows the authoritative production asset (never the selected concept),
 * customer-safe metadata, download, and an explicit reopen for further edits.
 */
export function FinalArtworkDeliveryCard({
  projectId,
  onMakeAnotherChange,
  showMakeAnotherChange = true,
  fetchProductionArtwork = defaultFetchProductionArtwork,
  forcedLoadState,
}: FinalArtworkDeliveryCardProps) {
  const [loadState, setLoadState] = useState<DeliveryLoadState>({
    status: "loading",
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (forcedLoadState) return;

    let cancelled = false;
    // Defer the loading reset so the effect body stays free of synchronous
    // setState (react-hooks/set-state-in-effect).
    const loadingTimer = setTimeout(() => {
      if (!cancelled) setLoadState({ status: "loading" });
    }, 0);

    void loadProductionArtworkState(projectId, fetchProductionArtwork)
      .then((next) => {
        if (!cancelled) setLoadState(next);
      })
      .catch(() => {
        if (!cancelled) setLoadState({ status: "error" });
      });

    return () => {
      cancelled = true;
      clearTimeout(loadingTimer);
    };
  }, [projectId, fetchProductionArtwork, reloadToken, forcedLoadState]);

  function retry() {
    setReloadToken((token) => token + 1);
  }

  const displayState = forcedLoadState ?? loadState;

  return (
    <section
      className="mt-3 overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50/40 shadow-sm"
      aria-label="Print-ready artwork"
    >
      <div className="border-b border-emerald-200/80 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-950">
          Your print-ready artwork is ready
        </p>
      </div>

      {displayState.status === "loading" ? (
        <p className="px-4 py-8 text-sm text-muted">
          Loading your print-ready artwork…
        </p>
      ) : null}

      {displayState.status === "error" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-6">
          <p className="text-sm text-ink" role="alert">
            We couldn&apos;t load your print-ready artwork.
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-ink/90"
          >
            Retry
          </button>
        </div>
      ) : null}

      {displayState.status === "ready" ? (
        <div className="space-y-4 p-4">
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="block w-full overflow-hidden rounded-xl border border-black/8 focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/40"
            aria-label="Open full-size print-ready artwork preview"
          >
            <div
              className="flex min-h-[280px] items-center justify-center p-4 sm:min-h-[360px]"
              style={CHECKERBOARD_STYLE}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={displayState.artwork.url}
                alt={
                  displayState.artwork.designLabel
                    ? `Print-ready artwork: ${displayState.artwork.designLabel}`
                    : "Print-ready artwork"
                }
                className="max-h-[420px] w-full object-contain"
              />
            </div>
          </button>

          <div className="space-y-1">
            {displayState.artwork.designLabel ? (
              <p className="text-base font-semibold text-ink">
                {displayState.artwork.designLabel}
              </p>
            ) : null}
            {displayState.artwork.placementLabel ? (
              <p className="text-sm text-muted">
                {displayState.artwork.placementLabel}
              </p>
            ) : null}
            <p className="text-xs text-muted">
              {formatProductionArtworkMetadataLine(displayState.artwork)}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/projects/${projectId}/production-artwork/download`}
              className="inline-flex rounded-full bg-ink px-3.5 py-1.5 text-xs font-medium text-white transition hover:bg-ink/90"
            >
              Download Print-Ready Artwork
            </a>
            {showMakeAnotherChange ? (
              <button
                type="button"
                onClick={onMakeAnotherChange}
                className="inline-flex rounded-full border border-black/15 bg-white px-3.5 py-1.5 text-xs font-medium text-ink transition hover:bg-black/[0.03]"
              >
                Make Another Change
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {previewOpen && displayState.status === "ready" ? (
        <ProductionPreviewModal
          artwork={displayState.artwork}
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </section>
  );
}

/**
 * Pure load helper — used by the card and unit-tested for retry/reacquire
 * without mounting React effects.
 */
export async function loadProductionArtworkState(
  projectId: string,
  fetchProductionArtwork: (
    projectId: string,
  ) => Promise<ProductionArtworkClientView | null>,
): Promise<DeliveryLoadState> {
  try {
    const artwork = await fetchProductionArtwork(projectId);
    if (!artwork) return { status: "error" };
    return { status: "ready", artwork };
  } catch {
    return { status: "error" };
  }
}

function ProductionPreviewModal({
  artwork,
  onClose,
}: {
  artwork: ProductionArtworkClientView;
  onClose: () => void;
}) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 sm:p-8"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Full preview of print-ready artwork"
        className="relative flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
        >
          ×
        </button>
        <div
          className="flex min-h-[45vh] flex-1 items-center justify-center p-4 sm:p-8"
          style={CHECKERBOARD_STYLE}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={artwork.url}
            alt={
              artwork.designLabel
                ? `Print-ready artwork: ${artwork.designLabel}`
                : "Print-ready artwork"
            }
            className="max-h-[80vh] max-w-full object-contain"
          />
        </div>
      </div>
    </div>
  );
}

async function defaultFetchProductionArtwork(
  projectId: string,
): Promise<ProductionArtworkClientView | null> {
  const response = await fetch(
    `/api/projects/${projectId}/production-artwork/image`,
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Failed to load print-ready artwork");
  const body = (await response.json()) as Partial<ProductionArtworkClientView>;
  if (typeof body.url !== "string" || !body.url) return null;
  return {
    url: body.url,
    filename:
      typeof body.filename === "string" ? body.filename : "print-ready-artwork.png",
    mimeType: typeof body.mimeType === "string" ? body.mimeType : "image/png",
    widthPx: typeof body.widthPx === "number" ? body.widthPx : null,
    heightPx: typeof body.heightPx === "number" ? body.heightPx : null,
    transparent: typeof body.transparent === "boolean" ? body.transparent : null,
    placementLabel:
      typeof body.placementLabel === "string" ? body.placementLabel : null,
    designLabel: typeof body.designLabel === "string" ? body.designLabel : null,
    widthIn: typeof body.widthIn === "number" ? body.widthIn : null,
    heightIn: typeof body.heightIn === "number" ? body.heightIn : null,
    dpi: typeof body.dpi === "number" ? body.dpi : null,
  };
}
