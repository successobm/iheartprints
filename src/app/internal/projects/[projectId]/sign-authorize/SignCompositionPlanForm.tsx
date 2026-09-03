"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Signs Phase 3B (Canvas-First Correction): the smallest governed
 * mechanism letting an internal production operator build a canvas-first
 * composition plan — `crop_region`, `fit_artwork_to_canvas`, `move_region`,
 * `fill_rect` (`sign-composition-plan-builder.ts`). Deliberately NOT
 * Photoshop: no drag/drop, no freehand masks, no polygons, no OCR — plain
 * numeric fields the operator fills in after looking at the artwork
 * preview already rendered above this form (and, once available, the
 * reconstructed-intermediate preview the same page can show).
 *
 * Calls `POST /api/internal/projects/[projectId]/sign-artwork/composition-
 * plan`, which independently re-derives the canvas from the ordered spec
 * (never from these numbers) and fails closed on any geometrically invalid
 * choice before persisting anything. On success, `router.refresh()`
 * re-reads authoritative server state.
 */

interface MoveRow {
  sourceStartYPx: string;
  heightPx: string;
  destStartYPx: string;
}

interface FillRow {
  xPx: string;
  yPx: string;
  widthPx: string;
  heightPx: string;
  r: string;
  g: string;
  b: string;
}

interface ReplacementRow {
  xPx: string;
  yPx: string;
  widthPx: string;
  heightPx: string;
  r: string;
  g: string;
  b: string;
  contextDepthPx: string;
}

export function SignCompositionPlanForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [useReconstruction, setUseReconstruction] = useState(true);
  const [reqScale, setReqScale] = useState("");
  const [reqW, setReqW] = useState("");
  const [reqH, setReqH] = useState("");

  const [useCrop, setUseCrop] = useState(false);
  const [cropX, setCropX] = useState("");
  const [cropY, setCropY] = useState("");
  const [cropW, setCropW] = useState("");
  const [cropH, setCropH] = useState("");

  const [bgR, setBgR] = useState("255");
  const [bgG, setBgG] = useState("255");
  const [bgB, setBgB] = useState("255");

  const [usePlacement, setUsePlacement] = useState(false);
  const [placeX, setPlaceX] = useState("");
  const [placeY, setPlaceY] = useState("");

  const [moves, setMoves] = useState<MoveRow[]>([]);
  const [fills, setFills] = useState<FillRow[]>([]);
  const [replacements, setReplacements] = useState<ReplacementRow[]>([]);

  function num(s: string): number {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`"${s}" is not a valid number.`);
    return n;
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = {
        reconstruction: useReconstruction
          ? { requestedScale: num(reqScale), requestedWidthPx: num(reqW), requestedHeightPx: num(reqH) }
          : null,
        crop: useCrop ? { xPx: num(cropX), yPx: num(cropY), widthPx: num(cropW), heightPx: num(cropH) } : null,
        fitBackground: { r: num(bgR), g: num(bgG), b: num(bgB) },
        fitPlacement: usePlacement ? { xPx: num(placeX), yPx: num(placeY) } : null,
        moves: moves.map((m) => ({ sourceStartYPx: num(m.sourceStartYPx), heightPx: num(m.heightPx), destStartYPx: num(m.destStartYPx) })),
        fills: fills.map((f) => ({ xPx: num(f.xPx), yPx: num(f.yPx), widthPx: num(f.widthPx), heightPx: num(f.heightPx), color: { r: num(f.r), g: num(f.g), b: num(f.b) } })),
        replacements: replacements.map((r) => ({ xPx: num(r.xPx), yPx: num(r.yPx), widthPx: num(r.widthPx), heightPx: num(r.heightPx), color: { r: num(r.r), g: num(r.g), b: num(r.b) }, contextDepthPx: num(r.contextDepthPx) })),
      };
      const res = await fetch(`/api/internal/projects/${projectId}/sign-artwork/composition-plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const responseBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(responseBody?.error ?? "That didn't work. Please try again.");
        setSubmitting(false);
        return;
      }
      router.refresh();
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That didn't work. Please try again.");
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded-full border border-ink/20 px-3.5 py-2 text-sm font-medium text-ink transition hover:bg-ink/5"
        data-testid="sign-composition-plan-open"
      >
        Build canvas-first composition plan
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-ink/15 p-3">
      <p className="text-sm text-ink/70">
        Canvas-first composition (Signs Phase 3B). The output canvas is derived from the ordered spec alone —
        crop/fit/move/fill are explicit production decisions.
      </p>

      <fieldset className="flex flex-col gap-1 rounded border border-ink/10 p-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={useReconstruction} onChange={(e) => setUseReconstruction(e.target.checked)} />
          Adopt a bounded reconstruction (e.g. existing paid Topaz intermediate)
        </label>
        {useReconstruction ? (
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1">scale <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={reqScale} onChange={(e) => setReqScale(e.target.value)} /></label>
            <label className="flex items-center gap-1">width px <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={reqW} onChange={(e) => setReqW(e.target.value)} /></label>
            <label className="flex items-center gap-1">height px <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={reqH} onChange={(e) => setReqH(e.target.value)} /></label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-1 rounded border border-ink/10 p-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={useCrop} onChange={(e) => setUseCrop(e.target.checked)} />
          Crop the artwork before fitting (e.g. remove a decorative frame)
        </label>
        {useCrop ? (
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1">x <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={cropX} onChange={(e) => setCropX(e.target.value)} /></label>
            <label className="flex items-center gap-1">y <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={cropY} onChange={(e) => setCropY(e.target.value)} /></label>
            <label className="flex items-center gap-1">width <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={cropW} onChange={(e) => setCropW(e.target.value)} /></label>
            <label className="flex items-center gap-1">height <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={cropH} onChange={(e) => setCropH(e.target.value)} /></label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-wrap items-center gap-2 rounded border border-ink/10 p-2 text-sm">
        <span className="font-medium text-ink/60">Canvas background (measured colour):</span>
        <label className="flex items-center gap-1">R <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={bgR} onChange={(e) => setBgR(e.target.value)} /></label>
        <label className="flex items-center gap-1">G <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={bgG} onChange={(e) => setBgG(e.target.value)} /></label>
        <label className="flex items-center gap-1">B <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={bgB} onChange={(e) => setBgB(e.target.value)} /></label>
      </fieldset>

      <fieldset className="flex flex-col gap-1 rounded border border-ink/10 p-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={usePlacement} onChange={(e) => setUsePlacement(e.target.checked)} />
          Explicit fit placement (unchecked = centered)
        </label>
        {usePlacement ? (
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1">x <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={placeX} onChange={(e) => setPlaceX(e.target.value)} /></label>
            <label className="flex items-center gap-1">y <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={placeY} onChange={(e) => setPlaceY(e.target.value)} /></label>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded border border-ink/10 p-2 text-sm">
        <span className="font-medium text-ink/60">Move operations (horizontal bands, in order):</span>
        {moves.map((m, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">source y <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={m.sourceStartYPx} onChange={(e) => setMoves((prev) => prev.map((r, j) => (j === i ? { ...r, sourceStartYPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">height <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={m.heightPx} onChange={(e) => setMoves((prev) => prev.map((r, j) => (j === i ? { ...r, heightPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">dest y <input className="w-24 rounded border border-ink/20 px-1.5 py-0.5" value={m.destStartYPx} onChange={(e) => setMoves((prev) => prev.map((r, j) => (j === i ? { ...r, destStartYPx: e.target.value } : r)))} /></label>
            <button type="button" onClick={() => setMoves((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-red-600 underline">remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setMoves((prev) => [...prev, { sourceStartYPx: "", heightPx: "", destStartYPx: "" }])} className="self-start text-sm text-ink/70 underline">
          + add move
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded border border-ink/10 p-2 text-sm">
        <span className="font-medium text-ink/60">Fill rectangles (bounded, in order):</span>
        {fills.map((f, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">x <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={f.xPx} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, xPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">y <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={f.yPx} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, yPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">w <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={f.widthPx} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, widthPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">h <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={f.heightPx} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, heightPx: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">R <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={f.r} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, r: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">G <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={f.g} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, g: e.target.value } : r)))} /></label>
            <label className="flex items-center gap-1">B <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={f.b} onChange={(e) => setFills((prev) => prev.map((r, j) => (j === i ? { ...r, b: e.target.value } : r)))} /></label>
            <button type="button" onClick={() => setFills((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-red-600 underline">remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setFills((prev) => [...prev, { xPx: "", yPx: "", widthPx: "", heightPx: "", r: "", g: "", b: "" }])} className="self-start text-sm text-ink/70 underline">
          + add fill
        </button>
      </fieldset>

      <fieldset className="flex flex-col gap-2 rounded border border-ink/10 p-2 text-sm">
        <span className="font-medium text-ink/60">Remove unwanted artifacts (Fit to Production — e.g. a stray hole/circle graphic), applied last:</span>
        <p className="text-xs text-muted">
          Replaces an exact rectangle with a measured background colour. The system independently re-verifies the
          surrounding context (out to &quot;context&quot; px) genuinely matches that colour before applying — it
          refuses rather than risk erasing anything that crosses non-uniform artwork.
        </p>
        {replacements.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1">x <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={r.xPx} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, xPx: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">y <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={r.yPx} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, yPx: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">w <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={r.widthPx} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, widthPx: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">h <input className="w-16 rounded border border-ink/20 px-1.5 py-0.5" value={r.heightPx} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, heightPx: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">R <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={r.r} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, r: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">G <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={r.g} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, g: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">B <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={r.b} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, b: e.target.value } : row)))} /></label>
            <label className="flex items-center gap-1">context <input className="w-14 rounded border border-ink/20 px-1.5 py-0.5" value={r.contextDepthPx} onChange={(e) => setReplacements((prev) => prev.map((row, j) => (j === i ? { ...row, contextDepthPx: e.target.value } : row)))} /></label>
            <button type="button" onClick={() => setReplacements((prev) => prev.filter((_, j) => j !== i))} className="text-xs text-red-600 underline">remove</button>
          </div>
        ))}
        <button type="button" onClick={() => setReplacements((prev) => [...prev, { xPx: "", yPx: "", widthPx: "", heightPx: "", r: "", g: "", b: "", contextDepthPx: "5" }])} className="self-start text-sm text-ink/70 underline">
          + add artifact removal
        </button>
      </fieldset>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="rounded-full bg-ink px-3.5 py-2 text-sm font-medium text-white transition enabled:hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40"
          data-testid="sign-composition-plan-submit"
        >
          {submitting ? "Building…" : "Build composition plan"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-ink/60 underline">
          Cancel
        </button>
      </div>
      {error ? (
        <p className="text-sm text-red-600" role="alert" data-sign-composition-plan-error>
          {error}
        </p>
      ) : null}
    </div>
  );
}
