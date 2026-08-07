# Sprint 2M Phase 2D — Bake-Off Results (Phases B–D)

**Executed:** 2026-08-07
**Harness:** `research/phase-2d-bakeoff/run-bakeoff.mjs`
**Machine JSON:** `research/phase-2d-bakeoff/reports/bakeoff-results-latest.json`

## Executive verdict

All **6** Topaz jobs succeeded. **6 credits** consumed (80 → 74).

**Primary candidate:** Topaz **`Transparency Upscale`** @ **4096×4096 PNG**, `crop_to_fill=false`.

**Decision A** — proven enough to begin Phase 2E integration of this mode behind `FinalArtworkProvider`, with mandatory production OCR, alpha verification, reconstructed provenance honesty, and **no** automatic inheritance of concept wording.

**Do not** use **Text Refine** as the primary DTF path — it systematically increases opaque pixel share (alpha degradation).

---

## Dimension honesty (binding)

| Concept | Value |
|---|---|
| Requested / returned reconstruction | **4096×4096** (exact **4.0×** each axis) |
| Reconstructed artwork short side | **4096 px** |
| Full-back production **canvas** | **3600×4200** |
| Usable content box @ 5% margin (contain) | ~**3240** short side |
| Claim allowed | 4096 reconstructed px can satisfy the ~3240 short-side content requirement after contain/pad |
| Claim **forbidden** | “We have 4200px of native reconstructed height” merely because of a 3600×4200 canvas |

Padding/contain after reconstruction remains **deterministic geometric prep**, not reconstructed detail.

Left-chest **1200×1200** is easily covered by 4× from 1024.

---

## 1–5. Calls, cost, latency

| Metric | Value |
|---|---|
| Paid calls attempted / succeeded | **6 / 6** |
| Credits before → after | **80 → 74** |
| Credits consumed | **6** (1 per job) |
| Est. USD @ $0.12/credit | **~$0.72** (plan-dependent; credit count is authoritative) |
| Failures / retries | **0** hard failures; no retries needed |

| Run | Model | Latency | Output | Bytes |
|---|---|---|---|---|
| A Transparency | Transparency Upscale | **69.5 s** | 4096×4096 | 21.8 MB |
| A Text Refine | Text Refine | **19.0 s** | 4096×4096 | 22.1 MB |
| B Transparency | Transparency Upscale | **96.1 s** | 4096×4096 | 30.7 MB |
| B Text Refine | Text Refine | **14.9 s** | 4096×4096 | 28.3 MB |
| C Transparency | Transparency Upscale | **128.0 s** | 4096×4096 | 24.9 MB |
| C Text Refine | Text Refine | **14.1 s** | 4096×4096 | 23.3 MB |

Transparency Upscale is slower (≈70–130s) but acceptable for low-volume final-artwork jobs. Text Refine is faster (≈14–19s).

---

## 8. Alpha / transparency (from returned bytes)

| Run | Src fullT% | Out fullT% | Src opaque% | Out opaque% | Opaque backdrop? |
|---|---|---|---|---|---|
| A Transparency | 77.1 | **78.3** | 8.2 | **4.5** | No |
| A Text Refine | 77.1 | 75.9 | 8.2 | **18.1** ↑ | No |
| B Transparency | 48.7 | **51.9** | 24.2 | **9.1** | No |
| B Text Refine | 48.7 | 47.9 | 24.2 | **44.2** ↑↑ | No |
| C Transparency | 78.3 | **79.3** | 7.8 | **1.0** | No |
| C Text Refine | 78.3 | 76.5 | 7.8 | **16.1** ↑ | No |

**Finding:** Transparency Upscale **preserves / improves** transparent area. Text Refine **converts substantial semi-transparent/edge mass toward opaque** — unsuitable as primary DTF reconstruction.

---

## 9. Exact wording (“My 3 Sons”)

| Run | OCR detected | Match vs required | Visual judgment |
|---|---|---|---|
| A Transparency | `MY SONS` | FAIL (no `3`) | Source A itself has literal **MY** + **SONS** only; the “3” is implied by three portraits, not printed. Reconstruction did **not** invent/remove a numeral that wasn’t there. |
| A Text Refine | `MY SONS` | FAIL (same) | Same as source structure |
| B Transparency | `MY 3 SONS` | **PASS** | Literal MY / 3 / SONS preserved |
| B Text Refine | `MY 3 SONS` | **PASS** | Preserved |
| C Transparency | `MY 3 SONS` | **PASS** | Banner text preserved |
| C Text Refine | `MY 3 SONS` | **PASS** | Preserved |

**Finding:** Where the approved concept contains the literal string, both modes preserved it under OCR. Harness “FAIL” on A is a **source/brief mismatch** (required wording expects “3”; concept encodes three sons graphically), not evidence of Topaz destroying a printed “3”.

Phase 2E must still **re-OCR production assets** — never inherit concept evaluation across reconstruction.

---

## 10. Design fidelity (visual)

Compared source vs output (full PNGs + downscaled previews):

| Design | Transparency Upscale | Text Refine |
|---|---|---|
| A Bold & Direct | Same composition: 3 portraits, bowler silhouette, MY/SONS split, ball. No obvious invented/removed major objects. Sharper edges at 4×. | Same composition retained. |
| B Soft illustrated | Same MY / 3 / SONS hierarchy, ball, portrait cluster, stipple texture language. No material redesign observed. (Source already has a dense multi-face layout; outputs match that language.) | Same; slightly cleaner edges. |
| C Minimal badge | Same crest, 3 silhouettes (center mustache), ball, 2 pins, MY 3 SONS banner. No redesign. | Same. |

**Unwanted additions/removals:** None material observed on these three designs for either mode.
**Stylistic redraw:** Not observed as a full redesign; detail appears sharpened/reconstructed rather than reimagined.
**Caveat:** n=3 only; automated ArtworkFidelityEvaluation does not exist yet — Phase 2E should keep a fidelity/human-review escape hatch.

---

## 11. Artifacts

| Kind | Location |
|---|---|
| Sources | `research/phase-2d-bakeoff/sources/` |
| Full outputs | `research/phase-2d-bakeoff/outputs/*.png` (≈22–31 MB each) |
| Side-by-side previews (source left / output right @ 512) | `research/phase-2d-bakeoff/reports/previews/` |
| Machine results | `research/phase-2d-bakeoff/reports/bakeoff-results-latest.json` |

Preview files:

- `A_typography__source_left__output_right.png` (Transparency)
- `A_typography_tr__source_left__output_right.png` (Text Refine)
- `B_illustrated__source_left__output_right.png`
- `B_illustrated_tr__source_left__output_right.png`
- `C_transparent__source_left__output_right.png`
- `C_transparent_tr__source_left__output_right.png`

---

## 12. Failures / retries

None. All submits completed on first attempt.

---

## 13. Comparison table

| Criterion | Transparency Upscale | Text Refine |
|---|---|---|
| Resolution (genuine 4× / ≥~3240 short side) | **PASS** | **PASS** |
| Exact wording (when literal in source) | **PASS** | **PASS** |
| Design fidelity (visual, n=3) | **PASS** (conditional on small sample) | **PASS** (conditional) |
| Transparency / alpha | **PASS** | **FAIL as DTF primary** (opaque% rises sharply) |
| Commercial practicality | **PASS** (~$0.12, 70–130s) | Faster, but alpha cost |
| Overall for iHeartPrints DTF | **PASS — primary** | **Not primary** |

---

## 14. Recommended provider / settings

```
Provider: Topaz Labs Image API
Endpoint: POST /image/v1/tool/async
Model: Transparency Upscale
output_width: 4096
output_height: 4096
output_format: png
crop_to_fill: false
Auth: X-API-Key = TOPAZ_API_KEY
```

Then (separate, local, deterministic): contain + transparent pad to `ProductionRequirements` canvas (e.g. 3600×4200).
Provenance: reconstructed detail = provider output dimensions (4096²), **not** padded canvas size.
`preservesApprovedContent`: treat as **false** for wording inheritance; re-verify on production asset.

**Reject as primary:** Text Refine for apparel DTF (alpha regression).

---

## 15–16. Decision gate & Phase 2E

| Gate | Result |
|---|---|
| Genuine new detail beyond interp | **PASS** (provider 4× SR, not local resample) |
| Reach production dims path | **PASS** (4096 ≥ ~3240 usable short side) |
| Consume approved artwork | **PASS** |
| Preserve design sufficiently | **PASS** on this sample (with review hatch) |
| Isolate behind FinalArtworkProvider | **PASS** (architecture ready) |
| Exact wording method | **PASS** path exists (re-OCR); preserved when literal |
| Honest provenance | **PASS** if canvas≠reconstructed is enforced |

**Phase 2D decision gate: PASSES for Transparency Upscale.**

**Phase 2E integration: YES — begin**, with:

1. Default-off `FINAL_ARTWORK_PROVIDER=topaz` (name TBD)
2. Keep `LocalRasterInterpolationProvider` as fallback/tests — never silent-equivocate
3. Add reconstructed provenance distinct from interpolated
4. Mandatory production OCR for required wording
5. Mandatory alpha scan
6. Fidelity uncertainty → `finalization_required` / needs_review, not auto `print_ready`
7. Credit-balance / 412 fail-closed (no retry storm)
8. Do **not** weaken Print Validation honesty rules

---

## Phase D — Decision

### DECISION A — PROVIDER PROVEN ENOUGH FOR PHASE 2E

**Provider:** Topaz **Transparency Upscale** via `/tool/async`, **4096×4096 PNG**, no crop.

**Phase 2E should begin** for adapter + provenance + verification wiring — not for blind auto-`print_ready`.

### Remaining limitations

- Sample size n=3 (one theme family). Broader styles still untested.
- Source A lacks a literal printed “3” while brief requires “My 3 Sons” — product/generation issue, not upscaler.
- No automated ArtworkFidelityEvaluation yet.
- Text Refine remains useful for opaque/text-only experiments, not DTF primary.
- Worker latency budget must tolerate ~2 minutes/job for Transparency Upscale.

### Recommended next sprint (Phase 2E)

Implement Topaz Transparency Upscale behind `FinalArtworkProvider`, extend provenance (`reconstructed` vs `interpolated_upscale`), re-OCR + alpha gates, keep local interpolation fallback, update ARCHITECTURE.md / capability boundaries — still no vector/PDF/embroidery scope.

---

## Files

**Created/updated:** this report, preview PNGs under `reports/previews/`, harness outputs, `ocr-sources.mjs`, `check-credits.mjs`.
**Not modified:** Print Validation, project status, FinalDirectionApproval, FinalArtworkJob, production assets.
**Not committed / not pushed.**
