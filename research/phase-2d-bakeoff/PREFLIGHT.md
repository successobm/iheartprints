# Sprint 2M Phase 2D — Bake-Off Pre-Flight

**Status:** READY TO RUN EXCEPT `TOPAZ_API_KEY`  
**Date:** 2026-08-07  
**Spend gate:** estimated max ≈ **$1.08** (≤ $5) — authorized to proceed once key is present.

## 1. Provider(s) selected

Primary path: **Topaz Labs Image API (direct)** — preservation-oriented Gigapixel family.

| Priority | Model | Endpoint | Why |
|---|---|---|---|
| 1 | `Transparency Upscale` | `POST https://api.topazlabs.com/image/v1/tool/async` | Docs: up to **4×**, PNG-only, preserves alpha — best match for DTF. Source: [tool.md](https://developer.topazlabs.com/reference/api-endpoints/image/tool.md), [transparent-image-upscale.md](https://developer.topazlabs.com/image-models/gigapixel/transparent-image-upscale.md) |
| 2 | `Text Refine` | `POST https://api.topazlabs.com/image/v1/enhance/async` | Docs: typography / logos / shapes; non-generative precision. Source: [text-and-shapes.md](https://developer.topazlabs.com/image-models/gigapixel/text-and-shapes.md), [quickstart.md](https://developer.topazlabs.com/getting-started/quickstart.md) |
| 3 (only if budget remains) | `CGI` | same enhance/async | Art/illustration preservation; skip generative Wonder/Bloom/Redefine. Source: [art-and-cgi.md](https://developer.topazlabs.com/image-models/gigapixel/art-and-cgi.md) |

**Not selected as primary:** OpenAI image edit/gen (prior Phase 2D audit: cannot emit 3600×4200; gpt-image-2 no transparency; redesign risk).  
**Not selected:** fal `fal-ai/topaz/upscale/image` as primary — cheaper (~$0.08/≤24MP) but model enum does **not** expose `Transparency Upscale`; default JPEG. Keep as optional fallback only if direct Topaz is unavailable.

Auth header: `X-API-Key: $TOPAZ_API_KEY` (docs also show `X-API-KEY`).

## 2. Exact endpoint / model / mode

```
Transparency Upscale:
  POST /image/v1/tool/async
  multipart: model=Transparency Upscale, output_width=4096, output_height=4096,
             output_format=png, crop_to_fill=false, image=<png>

Text Refine:
  POST /image/v1/enhance/async
  multipart: model=Text Refine, output_width=4096, output_height=4096,
             output_format=png, crop_to_fill=false, face_enhancement=false, image=<png>

Then poll GET /image/v1/status/{process_id}
Then GET /image/v1/download/{process_id} → download_url
```

Target reconstructed size: **4096×4096** (≈4× from 1024²). Deterministic contain/pad to 3600×4200 is a **separate** post-step and is **not** counted as reconstructed detail.

## 3. Documented pricing

| Source | Rate |
|---|---|
| Topaz marketing API page | Pay-as-you-go **$0.12 / credit** (Starter); Pro $0.10; Business $0.08 |
| Gigapixel / Transparency / Text Refine tables | **1 credit** for output ≤24 MP; 2 credits at 32 MP |
| 4096×4096 = 16.78 MP | **1 credit** ≈ **$0.12** at pay-as-you-go |
| fal Topaz (fallback docs) | **$0.08** / ≤24 MP |

Sources: https://www.topazlabs.com/api , model pricing tables on Transparency Upscale / Text & Shapes pages, https://fal.ai/models/fal-ai/topaz/upscale/image/llms.txt

## 4. Expected number of calls

- **6 calls** baseline: 3 sources × 2 models (`Transparency Upscale`, `Text Refine`)
- Optional +3 `CGI` only if first results are ambiguous and remaining budget allows

## 5. Estimated maximum spend

| Plan | Calls | Est. @ $0.12/credit |
|---|---|---|
| Baseline | 6 | **~$0.72** |
| + CGI | 9 | **~$1.08** |

**≤ $5 — spend gate PASSED.**

OpenAI source generation: **not needed** (real concepts downloaded). Evaluation OCR may use existing `OPENAI_API_KEY` / vision eval path — small additional cost if run; not counted as reconstruction spend.

## 6. Source assets selected

Copied **read-only** into `research/phase-2d-bakeoff/sources/` from private Supabase `design-assets` (not classified as `production_png`; no project status changes).

| Category | File | Asset id | Native | Alpha (measured) |
|---|---|---|---|---|
| A Typography | `A_typography__bold_direct_my3sons.png` | `3024ba9e-f808-421a-9fce-4498b53a8a90` | 1024×1024 PNG | ~77% fully transparent, ~15% semi |
| B Illustrated | `B_illustrated__soft_illustrated_my3sons.png` | `e0cef668-b0b6-43a5-9a9a-a8db1ea7b74e` | 1024×1024 PNG | ~49% fully transparent, ~27% semi |
| C Transparent badge | `C_transparent__minimal_badge_my3sons.png` | `ad8f9da3-98c3-4339-9ec6-41e57d1ffac3` | 1024×1024 PNG | ~78% fully transparent, ~14% semi |

Required wording target for evaluation: **"My 3 Sons"** (artwork renders as **MY 3 SONS** / split MY · 3 · SONS — case-normalized match per existing `wordingMatches`).

## 7. Why each is a useful stress test

- **A:** High-contrast, typography-forward composition with faces + bowler + ball — stresses letterforms and object identity.
- **B:** Multi-element illustrated logo with central “3”, portraits, ball, textured fills — stresses composition / iconography / texture hallucination.
- **C:** Badge silhouette with irregular crest edges + banner text — stresses alpha edges / fringing / transparency survival.

All are real iHeartPrints OpenAI concepts for the My 3 Sons bowling theme (`full_back` placement).

## 8. Expected output dimensions

- Provider output: **4096×4096** (requested via `output_width`/`output_height`)
- Docs max edge for tool: **32000**; Transparency Upscale described as up to **4×**
- Left-chest 1200×1200: trivially covered by 4× path (and by native 1024 for sleeve only after honesty rules)
- Full-back usable content after 5% margin contain into 3600×4200: ~3240 short side — **4096 ≥ 3240** ⇒ resolution gate can pass **if** provenance is genuinely reconstructed

## 9. Transparency documented?

- **Transparency Upscale:** yes — PNG-only output; alpha-preserving by design (docs).
- **Text Refine / CGI via enhance:** PNG allowed; **alpha preservation not explicitly guaranteed** in enhance docs — must measure bytes.
- Claims will be based on returned PNG alpha scans, not docs alone.

## 10. Exact success criteria

For Phase 2E recommendation, a mode must show:

| Criterion | Pass bar |
|---|---|
| Resolution | Genuine reconstructed short side ≥ ~3240 (4× from 1024) — not interp-labeled |
| Design fidelity | No material redesign / invented / removed objects (human + checklist) |
| Exact wording | Detected wording matches `My 3 Sons` after normalize; visual confirm |
| Transparency | Alpha present; fully transparent pixels remain where source had them; no solid opaque backdrop |
| Practicality | Latency/cost OK for low-volume final-artwork jobs (~$0.12/call) |

## Blocker (Phase B cannot start)

`.env.local` has `OPENAI_API_KEY` but **no `TOPAZ_API_KEY`** and **no `FAL_KEY`**.

Add:

```
TOPAZ_API_KEY=...
```

Then run:

```
node research/phase-2d-bakeoff/run-bakeoff.mjs
```

No production Print Validation / FinalArtworkJob / project status changes are performed by this harness.
