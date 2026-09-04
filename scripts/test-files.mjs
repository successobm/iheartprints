/**
 * The authoritative list of test files `npm run test` runs, in order.
 *
 * Lifted out of `package.json` in Phase 1.1 for one concrete reason: the
 * enumerated list had grown to 8202 characters, and cmd.exe refuses a
 * command line longer than 8191. Registering two more test files made
 * `npm run test` fail on Windows with "The command line is too long" —
 * before running a single test. `scripts/run-tests.mjs` now spawns the
 * runner with this array as an argv array, which goes through CreateProcess
 * (32767-character limit) instead of the shell.
 *
 * Deliberately still an EXPLICIT list, not a glob. Three test files under
 * `src/` are intentionally not registered here, and a glob would silently
 * start running them. Registering a new test file is the same one-line
 * change it always was — it just happens in this file now.
 */
export const TEST_FILES = [
  "src/components/chat/chat-session.test.ts",
  "src/components/chat/create-new-choice.test.tsx",
  // Correction A: the Create New workflow transition — an authoritative
  // server action, never a synthetic customer message. The server half
  // (no user turn, idempotency, reload durability, clean brief and
  // generation prompt) runs against the real conversation-service path.
  "src/capabilities/conversation/create-new-workflow.test.ts",
  "src/components/chat/ChatApp.ssr.test.tsx",
  "src/components/chat/chat-affordances.test.ts",
  "src/components/chat/ConceptCards.test.tsx",
  "src/components/chat/ConceptPreviewModal.test.tsx",
  "src/components/chat/DesignSummaryCard.test.tsx",
  "src/components/chat/ConceptStatusBanner.test.tsx",
  "src/components/chat/RecommendationCard.test.tsx",
  "src/components/chat/DesignerDecisionCard.test.tsx",
  "src/components/chat/design-history.test.ts",
  "src/lib/services/conversation-persistence.test.ts",
  "src/lib/services/design-brief-decision.test.ts",
  "src/capabilities/conversation/conversation-capability.test.ts",
  "src/capabilities/design-brief/design-brief-capability.test.ts",
  "src/capabilities/design-summary/design-summary-capability.test.ts",
  "src/capabilities/brief-evaluation/brief-evaluation-capability.test.ts",
  "src/capabilities/intent-extraction/intent-extraction-capability.test.ts",
  "src/capabilities/intent-extraction/product-vs-design-subject.test.ts",
  // A4 Correction B: an object's color is a creative fact about the
  // subject, never the design's global palette. Pure extraction +
  // semantic-reconciliation matrix here; the live Jeep conversation it
  // came from is replayed end to end in
  // `conversation/subject-color-regression.test.ts` below.
  "src/capabilities/intent-extraction/subject-color-vs-palette.test.ts",
  // Post-A4 correction: a numeric decimal point is lexical content, not a
  // sentence boundary (`lib/domain/clause-boundaries.ts`). Covers the live
  // truncated Jeep message, measurements and non-measurement decimals, the
  // real periods that must still split, and the other consumers of the same
  // rule — product, required wording, the design-detail backstop, the
  // multi-turn merge, revision intent, and the generation prompt.
  "src/capabilities/intent-extraction/decimal-safe-clause-parsing.test.ts",
  "src/capabilities/shared/brief-field-quality.test.ts",
  "src/capabilities/shared/field-normalization.test.ts",
  "src/components/chat/concept-image-fetch-controller.test.ts",
  "src/components/chat/status-poll-controller.test.ts",
  "src/capabilities/conversation/bowling-team-regression.test.ts",
  "src/capabilities/conversation/subject-color-regression.test.ts",
  "src/capabilities/conversation/multi-scenario-regression.test.ts",
  "src/capabilities/interview-intelligence/interview-intelligence-capability.test.ts",
  "src/capabilities/product-intelligence/product-intelligence-capability.test.ts",
  "src/capabilities/revision-intelligence/revision-intelligence-capability.test.ts",
  "src/capabilities/revision-timeline/revision-timeline-capability.test.ts",
  "src/capabilities/regeneration-intelligence/regeneration-intelligence-capability.test.ts",
  "src/capabilities/concept-generation/concept-generation-capability.test.ts",
  "src/capabilities/concept-generation/concept-generation-pipeline.test.ts",
  "src/capabilities/conversation/conversation-revision.test.ts",
  "src/capabilities/shared/retry.test.ts",
  "src/capabilities/prompt-translation/prompt-translation-capability.test.ts",
  "src/capabilities/prompt-translation/creative-reference-extraction.test.ts",
  "src/lib/domain/concept-directions.test.ts",
  "src/capabilities/concept-evaluation/concept-evaluation-capability.test.ts",
  "src/capabilities/concept-evaluation/concept-evaluation-pipeline.test.ts",
  "src/capabilities/concept-evaluation/openai-concept-evaluation-provider.test.ts",
  "src/capabilities/concept-evaluation/resolve-concept-evaluation-provider.test.ts",
  "src/capabilities/concept-evaluation/print-palette-compliance.test.ts",
  "src/lib/config/concept-evaluation-provider-config.test.ts",
  "src/capabilities/providers/openai-concept-provider.test.ts",
  "src/capabilities/providers/concept-prompt-fidelity.test.ts",
  "src/capabilities/providers/no-text-contract.test.ts",
  "src/capabilities/assets/asset-capability.test.ts",
  "src/capabilities/assets/asset-capability-persistence-durability.test.ts",
  "src/capabilities/assets/asset-capability-production-storage.test.ts",
  "src/lib/config/generation-provider-config.test.ts",
  "src/lib/config/openai-concept-image-quality.test.ts",
  "src/lib/config/asset-storage-config.test.ts",
  "src/capabilities/providers/resolve-concept-provider.test.ts",
  "src/capabilities/providers/paid-image-arming.test.ts",
  "src/capabilities/concept-generation/concept-generation-unavailable.test.ts",
  "src/capabilities/concept-generation/concept-generation-production-safety.test.ts",
  // Sprint A3: the IP / trademark product safety boundary. Detection and
  // enforcement decisions, then the three fences that keep a blocked request
  // away from a paid provider, then the Existing Artwork distinction between
  // technical preparation and new protected-IP generation.
  "src/capabilities/ip-safety/ip-safety-capability.test.ts",
  "src/capabilities/ip-safety/ip-safety-generation-fence.test.ts",
  // Correction 1: what the PRODUCT does after the worker fence refuses —
  // terminal job, polling stops, concepts and selection intact, no permanent
  // revisionPending bar, and the customer can keep working.
  "src/capabilities/ip-safety/ip-safety-worker-lifecycle.test.ts",
  // Correction 2: safe evidence about one occurrence must not immunize a
  // different surviving request. End-to-end with a scripted semantic result,
  // because the defect it closes was a SPEND defect.
  "src/capabilities/ip-safety/ip-safety-semantic-scope-e2e.test.ts",
  "src/capabilities/ip-safety/existing-artwork-ip-safety.test.ts",
  "src/capabilities/asset-storage/signed-url-token.test.ts",
  "src/capabilities/asset-storage/filesystem-asset-storage-provider.test.ts",
  "src/capabilities/asset-storage/resolve-asset-storage-provider.test.ts",
  "src/capabilities/asset-storage/supabase-storage-asset-provider.test.ts",
  "src/capabilities/asset-storage/strict-unique-key-asset-storage-provider.test.ts",
  "src/capabilities/assets/png-thumbnail-generator.test.ts",
  "src/capabilities/generation-worker/generation-worker-capability.test.ts",
  "src/capabilities/generation-worker/generation-worker-concurrency.test.ts",
  "src/capabilities/generation-worker/generation-worker-regeneration.test.ts",
  "src/lib/services/conversation-service.test.ts",
  "src/app/api/assets/[...objectKey]/route.test.ts",
  "src/app/api/projects/[projectId]/generation/status/route.test.ts",
  "src/app/api/projects/[projectId]/finalization/status/route.test.ts",
  "src/app/api/projects/[projectId]/concepts/[artworkVersionId]/image/route.test.ts",
  "src/lib/config/worker-config.test.ts",
  "src/capabilities/worker-scheduler/worker-auth.test.ts",
  "src/capabilities/worker-scheduler/worker-rate-limiter.test.ts",
  "src/capabilities/worker-scheduler/worker-scheduler-capability.test.ts",
  // The local store resolves its path per call, so a suite that reaches this
  // module through its STATIC import graph still writes to its own temp
  // workspace and never to the developer's real .data/sprint1-store.json.
  "src/lib/db/local-store-isolation.test.ts",
  "src/lib/db/supabase-store.generation-jobs.test.ts",
  "src/app/api/worker/generation/route.test.ts",
  "src/capabilities/conversation-understanding/conversation-understanding-capability.test.ts",
  "src/capabilities/conversation-understanding/openai-conversation-understanding-provider.test.ts",
  "src/capabilities/conversation-understanding/resolve-conversation-understanding-provider.test.ts",
  "src/lib/config/conversation-understanding-provider-config.test.ts",
  "src/capabilities/intent-extraction/reconcile-understanding.test.ts",
  "src/capabilities/intent-extraction/detailed-description-fidelity.test.ts",
  "src/capabilities/intent-extraction/multi-turn-design-intent.test.ts",
  "src/capabilities/intent-extraction/intent-extraction-understanding-merge.test.ts",
  "src/capabilities/conversation/conversation-understanding-regression.test.ts",
  "src/capabilities/conversation/conversation-understanding-product-regression.test.ts",
  "src/capabilities/shared/question-phrasing-acknowledgement.test.ts",
  "src/capabilities/conversation/goal-directed-orchestration-regression.test.ts",
  "src/capabilities/conversation/live-vs-test-divergence-regression.test.ts",
  "src/capabilities/print-validation/print-validation-capability.test.ts",
  "src/capabilities/print-validation/decoration-intent-vs-production-output.test.ts",
  "src/capabilities/shared/requested-production-output.test.ts",
  "src/capabilities/print-validation/assemble-input.test.ts",
  "src/capabilities/generation-worker/generation-worker-print-validation.test.ts",
  "src/capabilities/final-artwork/final-artwork-capability.test.ts",
  "src/capabilities/final-artwork/dtf-provisional-revalidation.test.ts",
  "src/capabilities/final-artwork/production-request-identity.test.ts",
  "src/lib/services/final-artwork-service.test.ts",
  "src/app/api/projects/[projectId]/finalize/route.test.ts",
  "src/lib/db/supabase-store.final-artwork.test.ts",
  "src/components/chat/PrepareForPrintAction.test.tsx",
  "src/components/chat/FinalArtworkDeliveryCard.test.tsx",
  "src/lib/services/print-ready-filename.test.ts",
  "src/capabilities/final-artwork/raster-transform.test.ts",
  "src/capabilities/final-artwork/alpha-trim.test.ts",
  "src/capabilities/final-artwork/production-png.test.ts",
  "src/capabilities/final-artwork/production-normalization.test.ts",
  "src/capabilities/final-artwork/local-raster-provider.test.ts",
  "src/capabilities/final-artwork/feature-integrity/distance-transform.test.ts",
  "src/capabilities/final-artwork/feature-integrity/measure-feature-integrity.test.ts",
  "src/capabilities/final-artwork/dtf-coverage/measure-dtf-coverage.test.ts",
  "src/capabilities/final-artwork/dtf-physical-calibration/dtf-physical-calibration.test.ts",
  "src/capabilities/shared/dtf-feature-integrity-profile.test.ts",
  "src/capabilities/final-artwork-worker/final-artwork-worker-capability.test.ts",
  "src/capabilities/final-artwork-worker/two-pass-reconstruction.test.ts",
  "src/lib/config/final-artwork-provider-config.test.ts",
  "src/capabilities/final-artwork/resolve-final-artwork-provider.test.ts",
  "src/capabilities/final-artwork/topaz-transparency-upscale-provider.test.ts",
  // Print'em All Phase 0: the reconstruction request is derived from the
  // production plate, not from a constant. Pins the live 562x486 -> 10.5in
  // failure (which asked for 4x, needed 5.60x, and was correctly refused by
  // reconstruction_sufficiency after the credit was spent), plus the other
  // scale bands, the proportional maximum, the fail-before-dispatch case, and
  // the guarantee that the transparent prepared artwork stays the source.
  "src/capabilities/final-artwork/production-need-reconstruction.test.ts",
  "src/capabilities/final-artwork-worker/source-eligibility.test.ts",
  "src/capabilities/final-artwork-worker/production-verification.test.ts",
  "src/lib/config/automated-test-safety.test.ts",
  "src/lib/config/worker-http-batch-policy.test.ts",
  "src/lib/config/local-generation-trigger-policy.test.ts",
  "src/lib/services/local-generation-trigger.test.ts",
  "src/lib/services/local-final-artwork-trigger.test.ts",
  "src/app/api/dev/local-generation-trigger/route.test.ts",
  "src/capabilities/composition-test-safety.test.ts",
  "src/capabilities/generation-worker/generation-worker-claim-init.test.ts",
  "src/app/api/projects/[projectId]/production-artwork/image/route.test.ts",
  "src/app/api/projects/[projectId]/production-artwork/download/route.test.ts",
  "src/capabilities/shared/revision-intent.test.ts",
  "src/capabilities/conversation/rinker-boat-revision-regression.test.ts",
  "src/capabilities/conversation/live-acceptance-corrective-pass-regression.test.ts",
  "src/capabilities/conversation/approval-enqueue-recovery.test.ts",
  "src/capabilities/conversation/revision-enqueue-recovery.test.ts",
  "src/capabilities/shared/revision-delta.test.ts",
  "src/capabilities/providers/openai-concept-provider-edit.test.ts",
  "src/capabilities/prompt-translation/targeted-revision-delta.test.ts",
  "src/capabilities/generation-worker/targeted-revision-source-image.test.ts",
  "src/capabilities/conversation/revision-acknowledgement-delta.test.ts",
  "src/capabilities/conversation/post-revision-chat-state.test.ts",
  "src/capabilities/shared/brief-diff.test.ts",
  // Print'em All Phase 2 — the DTF halftone production treatment.
  "src/capabilities/shared/production-treatment.test.ts",
  "src/capabilities/shared/production-source-strategy.test.ts",
  "src/capabilities/artwork-preparation/enclosure-evidence.test.ts",
  "src/capabilities/artwork-preparation/garment-conditional-review.test.ts",
  "src/capabilities/artwork-preparation/region-separation.test.ts",
  "src/capabilities/artwork-preparation/in-bounds-proposal.test.ts",
  "src/capabilities/artwork-preparation/open-line-art-falsification.test.ts",
  "src/capabilities/artwork-preparation/proposal-adversarial-acceptance.test.ts",
  "src/capabilities/artwork-preparation/proposal-authority.test.ts",
  "src/capabilities/artwork-preparation/region-review-visual-clarity.test.ts",
  "src/capabilities/artwork-preparation/bowling-region-review-acceptance.test.ts",
  "src/components/chat/region-review-workspace.test.ts",
  "src/components/chat/proposal-review-workspace.test.ts",
  "src/components/chat/separation-review-workspace-shape.test.ts",
  "src/capabilities/artwork-preparation/separation-review.test.ts",
  "src/capabilities/artwork-preparation/separation-decision-workflow.test.ts",
  "src/capabilities/artwork-preparation/complex-background-operator-routing.test.ts",
  "src/app/api/projects/[projectId]/artwork-preparation/separation/separation-routes-authorization.test.ts",
  // Phase 28K: the narrow authorization predicate itself, and the
  // end-to-end proof that a genuinely non-internal project owner can now
  // see and resolve required separation review, with no false blocker for
  // the no-review-needed/partial/reload/manual-correction cases either --
  // registered immediately per the established discipline.
  "src/capabilities/artwork-preparation/artwork-correction-authorization.test.ts",
  "src/capabilities/artwork-preparation/impossible-separation-gate-regression.test.ts",
  "src/capabilities/artwork-preparation/continue-as-internal-job.test.ts",
  "src/app/api/internal/projects/[projectId]/continue-as-internal-job/continue-as-internal-job-route.test.ts",
  "src/app/internal/projects/[projectId]/continue/continue-page-state.test.ts",
  // Phase 28M: proves the already-existing internal/system-admin access
  // mechanism (POST /api/internal/acquisition-access) grants finalization
  // authority with no production_unlocks row, isolated to legitimate
  // internal sessions/projects, without weakening the ordinary commercial
  // gate -- registered immediately per the established discipline.
  "src/app/api/internal/acquisition-access/acquisition-access-route.test.ts",
  // Phase 28M.1: the operator-facing /internal/access bootstrap page's own
  // render-branch logic and the raw-key handling properties Section 8
  // requires -- registered immediately per the established discipline.
  "src/app/internal/access/internal-access-page.test.ts",
  "src/app/api/projects/[projectId]/artwork-preparation/separation/phase16-complex-background-routing.test.ts",
  "src/components/chat/uploaded-artwork-separation-mount.test.tsx",
  "src/capabilities/artwork-preparation/bowling-live-shape-ui-acceptance.test.ts",
  "src/capabilities/artwork-preparation/bowling-dtf-halftone-regression.test.ts",
  "src/capabilities/artwork-preparation/separation-reload-restart.test.ts",
  "src/capabilities/final-artwork/halftone-screen.test.ts",
  "src/capabilities/final-artwork-worker/halftone-production.test.ts",
  // Phase 28 Checkpoint Audit Section 11: proves, without any real network
  // call, that FINAL_ARTWORK_PROVIDER=topaz resolves and the real worker
  // pipeline actually invokes the REAL TopazTransparencyUpscaleProvider
  // class exactly once for a genuinely undersized source, and never at all
  // for a source that already satisfies the production target.
  "src/capabilities/final-artwork-worker/topaz-provider-selection-and-invocation.test.ts",
  "src/capabilities/final-artwork-worker/topaz-download-resume-recovery.test.ts",
  "src/capabilities/final-artwork-worker/final-artwork-attempt-budget.test.ts",
  "src/capabilities/conversation/production-treatment-authorization.test.ts",
  "src/components/chat/production-treatment-dead-end.test.tsx",
  "src/capabilities/conversation/operator-recovery-flow.test.ts",
  "src/capabilities/shared/waiting-copy.test.ts",
  "src/capabilities/shared/production-print-size.test.ts",
  "src/capabilities/shared/garment-production-sizing.test.ts",
  "src/capabilities/shared/orientation-aware-production-sizing.test.ts",
  "src/capabilities/conversation/concept-selection-lifecycle.test.ts",
  "src/capabilities/conversation/production-size-lifecycle.test.ts",
  // Phase 27L: garment-class selection now confirms print size in the same
  // action -- registered immediately per the established discipline.
  "src/capabilities/conversation/print-size-garment-confirmation.test.ts",
  "src/capabilities/conversation/incredi-bowls-print-size-acceptance.test.ts",
  "src/components/chat/PrintReadySizeCard.test.tsx",
  // Phase 27M: the real final-generation failure (root cause + fix) and the
  // async waiting-state UX regressions -- registered immediately per the
  // established discipline (Phase 27H found these previously omitted).
  "src/capabilities/final-artwork-worker/print-ready-generation-failure.test.ts",
  "src/components/chat/print-ready-waiting-state-ux.test.tsx",
  // Phase 27P: multi-variant print-ready package -- registered immediately
  // per the established discipline (Phase 27H found these previously omitted).
  "src/capabilities/shared/production-variant.test.ts",
  "src/capabilities/conversation/print-ready-multi-variant-package.test.ts",
  "src/components/chat/PrintReadyPackageCard.test.tsx",
  // Phase 28H: progressive print-ready file creation -- Standard Raster is
  // always attempted first, automatically, with no customer treatment
  // choice beforehand; DTF Halftone is offered only after Raster reaches a
  // terminal state (print_ready, needs_attention, or retryable_failure),
  // and creating it never touches Raster's own job/asset -- registered
  // immediately per the established discipline.
  "src/capabilities/conversation/print-ready-progressive-creation.test.ts",
  "src/components/chat/uploaded-artwork-print-ready-flow.test.tsx",
  // Existing Artwork → Print Ready Phase 1.
  "src/capabilities/artwork-preparation/upload-security.test.ts",
  "src/capabilities/artwork-preparation/image-analysis.test.ts",
  "src/capabilities/artwork-preparation/background-isolation.test.ts",
  "src/capabilities/artwork-preparation/artwork-preparation-capability.test.ts",
  "src/capabilities/artwork-preparation/bowling-upload-regression.test.ts",
  "src/capabilities/artwork-preparation/no-paid-provider.test.ts",
  // Signs Phase S1 (Constitution §16A): rigid-sign inspection, diagnosis,
  // and repair PLANNING — deterministic, provider-free, executes nothing.
  // Includes the Ruth-shaped synthetic acceptance fixture (1024×1536 → 18×24).
  "src/capabilities/sign-preparation/sign-inspection.test.ts",
  "src/capabilities/sign-preparation/sign-repair-planner.test.ts",
  "src/capabilities/sign-preparation/frame-structure-model.test.ts",
  "src/capabilities/sign-preparation/sign-transform-executor-parametric-frame.test.ts",
  "src/capabilities/sign-preparation/sign-preparation-capability.test.ts",
  // Structural Layout Reflow Phase 2B (Planning Orchestration Wiring):
  // reflow_structural_layout through the REAL SignPreparationCapability
  // path (upload -> confirm spec -> plan), not only direct unit calls.
  "src/capabilities/sign-preparation/sign-preparation-capability-structural-reflow.test.ts",
  // Structural Layout Reflow Phase 2C (Frame-Interior-Aware Segmentation):
  // reflow_structural_layout through the REAL SignPreparationCapability
  // path for a continuously-framed, multi-region banner sign.
  "src/capabilities/sign-preparation/sign-preparation-capability-frame-interior.test.ts",
  // Structural Layout Reflow Phase 2D (Bounded Transition-Run Segmentation):
  // reflow_structural_layout through the REAL SignPreparationCapability path
  // for a framed banner sign whose interior contains a bounded transition
  // row that, pre-Phase-2D, would have left segmentation ambiguous.
  "src/capabilities/sign-preparation/sign-preparation-capability-transition-runs.test.ts",
  "src/capabilities/sign-preparation/rigid-sign-category.test.ts",
  // Structural Layout Reflow Phase 1 (Foundations): dormant reflow_
  // structural_layout contract, SignProductionTemplate, the 0.125in safe
  // inset policy, and the deterministic structural-layout segmentation
  // module. Additive only — not wired into planning/execution.
  "src/capabilities/sign-preparation/sign-structural-reflow-foundations.test.ts",
  "src/capabilities/sign-preparation/sign-layout-segmentation.test.ts",
  // Structural Layout Reflow Phase 2C (Frame-Interior-Aware Segmentation):
  // the optional analysisWindow parameter, resolveFrameAnalysisWindow's
  // own validation, and frame-interior-windowed structural results.
  "src/capabilities/sign-preparation/sign-layout-segmentation-analysis-window.test.ts",
  // Structural Layout Reflow Phase 2D (Bounded Transition-Run Segmentation):
  // the deterministic bounded transition-run model — synthetic matrix (A-K,
  // plus the N/N+1 run-length boundary) and framed/windowed compatibility.
  "src/capabilities/sign-preparation/sign-layout-segmentation-transition-runs.test.ts",
  // Signs Phase 3A: operator-confirmed structural evidence — real
  // orchestration-path proof (deterministic-fails -> operator unlocks
  // reflow, staleness refused, planKey changes with the boundaries,
  // unprovable boundaries refused before persistence).
  "src/capabilities/sign-preparation/sign-operator-structural-override.test.ts",
  // Structural Layout Reflow Phase 2 (Planner Wiring): reflow_structural_
  // layout is now planner-emitted, but ONLY when a caller opts in by
  // supplying structuralLayoutSegmentation — still not executor-admitted.
  "src/capabilities/sign-preparation/sign-repair-planner-structural-reflow.test.ts",
  // Signs Phase S2 (Constitution §16A): deterministic repair execution +
  // authoritative rigid_sign_raster validation. Zero provider dispatch.
  "src/capabilities/sign-preparation/sign-transform-executor.test.ts",
  // Signs Phase 3A: reflow_structural_layout execution — the first version
  // of this step this codebase ever executes. Translation + gap
  // redistribution, actual-vs-planned reconstruction scale reconciliation.
  "src/capabilities/sign-preparation/sign-transform-executor-reflow.test.ts",
  // Signs Phase 3B (Canvas-First Correction): the four composition
  // primitives (crop_region/fit_artwork_to_canvas/move_region/fill_rect),
  // the operator-driven plan builder, and deterministic per-operation
  // verification.
  "src/capabilities/sign-preparation/sign-composition-steps.test.ts",
  "src/capabilities/sign-preparation/sign-composition-plan-builder.test.ts",
  "src/capabilities/sign-preparation/sign-composition-verification.test.ts",
  // Wand-First Correction UX Phase: the shared, DTF-and-Signs flood-fill
  // selection primitive, and Signs' own wand-selection wrapper (rectExact
  // safety gate, overlay-crop rendering, mask transport encoding).
  "src/capabilities/shared/flood-fill-selection.test.ts",
  "src/capabilities/sign-preparation/sign-wand-selection.test.ts",
  // Wand Performance Optimization Phase: the bounded, asset-identity-keyed
  // decoded-candidate cache (get/set, LRU eviction, cross-asset isolation).
  "src/lib/services/sign-wand-candidate-cache.test.ts",
  // Signs Phase 3B (Fit to Production): CUT/SAFE/BLEED/PROTECTED analysis
  // and the replace_region_with_background artifact-removal primitive.
  "src/capabilities/sign-preparation/sign-fit-to-production.test.ts",
  // Operator Production Correction UX: Smart Remove preview/commit service
  // — governed plan appending, preview/execution equivalence, Fit to
  // Production immediate recheck.
  "src/lib/services/sign-artwork-service.test.ts",
  // SIGNS QR DESTINATION RESOLUTION: confirmSignQrDestination /
  // acceptSignQrPrintAsSupplied service-layer integration, run against a
  // real local-store sign pipeline (no live-DB migration dependency).
  "src/lib/services/sign-qr-preservation-service.test.ts",
  // QR REPAIR V2: actor provenance for confirmSignQrDestination is entirely
  // server-derived per route — proves customer/internal routes each stamp
  // their own actor and a client-submitted confirmedBy is never trusted.
  "src/app/api/projects/[projectId]/sign-artwork/qr-destination/route.test.ts",
  // Edge-Intent Correction Phase: governed classification record decode/
  // encode/re-validation against current candidate/plan identity.
  "src/capabilities/sign-preparation/sign-edge-intent-classification.test.ts",
  // Signs Phase 3A: cross-plan Topaz intermediate reconstruction adoption —
  // a re-plan for the SAME sign preparation reuses a sufficient, already-
  // paid-for intermediate from a PRIOR job rather than dispatching a
  // second paid request; correctly refuses when insufficient.
  "src/capabilities/final-artwork-worker/sign-cross-plan-intermediate-adoption.test.ts",
  // Signs Phase 3A: end-to-end reflow_structural_layout execution through
  // the real worker — source -> reconstruction -> deterministic
  // segmentation -> planner -> authorize -> execute -> preservation ->
  // PrintValidation, proving the full chain never crashes.
  "src/capabilities/final-artwork-worker/sign-reflow-execution.test.ts",
  "src/capabilities/sign-preparation/sign-geometry.test.ts",
  "src/capabilities/sign-preparation/sign-provider-alpha-normalization.test.ts",
  "src/capabilities/sign-preservation/sign-preservation-deterministic-checks.test.ts",
  // LIVE PRODUCT BLOCKER #4C: source-space <-> reconstruction-space
  // coordinate mapping, tested in isolation from image bytes.
  "src/capabilities/sign-preservation/sign-preservation-geometry.test.ts",
  "src/capabilities/sign-preservation/sign-preservation-capability.test.ts",
  "src/capabilities/sign-preservation/sign-preservation-semantic-contract.test.ts",
  "src/capabilities/sign-preservation/sign-preservation-image-derivation.test.ts",
  "src/capabilities/sign-preservation/openai-sign-preservation-semantic-provider.test.ts",
  "src/capabilities/print-validation/rigid-sign-print-validation.test.ts",
  "src/capabilities/final-artwork-worker/sign-final-artwork.test.ts",
  "src/capabilities/final-artwork-worker/sign-reconstruction.test.ts",
  "src/capabilities/final-artwork-worker/exhausted-provider-result-recovery.test.ts",
  "src/capabilities/final-artwork-worker/post-provider-resume.test.ts",
  "src/capabilities/final-artwork-worker/sign-preservation-worker-orchestration.test.ts",
  "src/capabilities/final-artwork-worker/sign-print-ready-lifecycle.test.ts",
  "src/capabilities/final-artwork/topaz-download-security.test.ts",
  // LIVE PRODUCT BLOCKER #1/#3/#4/#4A/#4B: registered together — discovered
  // during Blocker #4B that none of these had ever been added to this list,
  // so `npm test` never actually ran them despite being reported as part of
  // the full regression suite in every prior phase's own report. See the
  // Blocker #4B final report for the full accounting.
  "src/app/api/projects/[projectId]/sign-artwork/route.test.ts",
  "src/app/api/projects/[projectId]/sign-artwork/plan/route.test.ts",
  "src/capabilities/sign-preparation/sign-preparation-copy.test.ts",
  "src/capabilities/sign-preparation/sign-plan-authorization.test.ts",
  "src/app/api/projects/[projectId]/sign-artwork/authorize/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/authorize/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/plan/route.test.ts",
  "src/capabilities/sign-preparation/sign-preparation-operator-copy.test.ts",
  "src/capabilities/sign-preparation/sign-plan-operator-review.test.ts",
  // SIGNS QR / MACHINE-READABLE CONTENT PRESERVATION.
  "src/capabilities/machine-readable-content/qr-detect-decode.test.ts",
  "src/capabilities/machine-readable-content/qr-preservation.test.ts",
  "src/capabilities/machine-readable-content/qr-restore.test.ts",
  // SIGNS QR DESTINATION RESOLUTION.
  "src/capabilities/machine-readable-content/qr-resolution.test.ts",
  "src/capabilities/machine-readable-content/qr-destination-validation.test.ts",
  "src/app/internal/projects/[projectId]/sign-authorize/sign-authorize-page-state.test.ts",
  // FIX AUTHORIZED SIGN PRODUCTION WORKSPACE CTA: the CTA-label state
  // machine (print-ready / in-flight / prepare vs. try-again), pulled out
  // of SignProductionAction.tsx as a pure, router-free function — same
  // reasoning as sign-canvas-zoom/correction-coordinate-mapping below.
  "src/app/internal/projects/[projectId]/sign-authorize/sign-production-cta-state.test.ts",
  // Operator Production Correction UX: pointer/CSS -> production-candidate
  // native pixel coordinate mapping, zoom-invariant, DOM-free.
  "src/app/internal/projects/[projectId]/sign-authorize/correction-coordinate-mapping.test.ts",
  // Production Workspace Phase: Fit-zoom math and compact-status derivation
  // — both pulled out of SignFitToProductionCorrectionTool.tsx as pure,
  // DOM-free functions, same reasoning as coordinate-mapping above.
  "src/app/internal/projects/[projectId]/sign-authorize/sign-canvas-zoom.test.ts",
  "src/app/internal/projects/[projectId]/sign-authorize/sign-workspace-status.test.ts",
  // Signs Workstation Visual Correction UX Phase: the main-canvas
  // preview/Apply-gating decision logic pulled out of
  // SignFitToProductionCorrectionTool.tsx, same reasoning as the other
  // pure, DOM-free modules above.
  "src/app/internal/projects/[projectId]/sign-authorize/sign-correction-preview-view.test.ts",
  // Signs Flat-Raster Production Workflow Correction: the four-state
  // (ready/fit-adjustment/edge-classification) decision logic pulled out
  // of SignFitToProductionCorrectionTool.tsx, same reasoning as the other
  // pure, DOM-free modules above.
  "src/app/internal/projects/[projectId]/sign-authorize/sign-production-fit-state.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/original-image/route.test.ts",
  "src/capabilities/final-artwork-worker/sign-production-delivery.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/prepare/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/resume-existing-result/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/resume-from-intermediate/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/production-candidate/route.test.ts",
  "src/app/api/internal/projects/[projectId]/sign-artwork/download/route.test.ts",
  // Garment colour is production context, never authority over customer
  // pixels: preparation must be byte-identical on a white and a black shirt.
  "src/capabilities/artwork-preparation/garment-color-preparation-isolation.test.ts",
  // The prepared asset is reviewable, not guaranteed unchanged: same-colour
  // design content connected to the background goes with it, so the copy
  // stops promising otherwise and the advisory is derived from evidence
  // `isolateBackground` already records.
  "src/capabilities/artwork-preparation/prepared-review-truthfulness.test.ts",
  // Phase 1 follow-up: enclosed background cavities (letter counters, ring
  // interiors) removed, intentional black artwork preserved.
  "src/capabilities/artwork-preparation/background-cavities.test.ts",
  "src/capabilities/artwork-preparation/bowling-cavity-acceptance.test.ts",
  // Phase 1.2: the three stages that answer the real-file audit — a measured
  // hairline-counter allowance, isolated speckle residue, and user-guided
  // removal of the regions no threshold can safely classify. Deliberately
  // three separate suites, because they are three separate mechanisms.
  "src/capabilities/artwork-preparation/background-speckle.test.ts",
  "src/capabilities/artwork-preparation/guided-removal.test.ts",
  "src/capabilities/artwork-preparation/guided-cleanup-capability.test.ts",
  "src/capabilities/artwork-preparation/guided-cleanup-confirmation.test.ts",
  "src/capabilities/artwork-preparation/guided-cleanup-operations.test.ts",
  "src/capabilities/artwork-preparation/guided-cleanup-highlight.test.ts",
  "src/capabilities/artwork-preparation/magic-color-selection.test.ts",
  "src/capabilities/artwork-preparation/magic-select-capability.test.ts",
  "src/capabilities/artwork-preparation/magic-select-bowling-acceptance.test.ts",
  "src/components/chat/dev-hmr-watch-hygiene.test.ts",
  "src/capabilities/artwork-preparation/prepared-revision.test.ts",
  "src/capabilities/artwork-preparation/prepared-asset-storage-identity.test.ts",
  "src/components/chat/artwork-click-mapping.test.ts",
  "src/components/chat/guided-cleanup-zoom.test.ts",
  "src/components/chat/guided-cleanup-interaction.test.ts",
  "src/components/chat/GuidedCleanupWorkspace.test.tsx",
  // The inspection surface. These existed but were never registered, so the
  // default could change without a single suite noticing — which is exactly
  // what needed noticing when it moved from White to Gray.
  "src/components/chat/preview-background.test.ts",
  "src/components/chat/PreviewBackgroundControl.test.tsx",
  "src/components/chat/uploaded-artwork-flow.test.ts",
  "src/components/chat/UploadedArtworkPanel.test.tsx",
  // Production Workspace Bridge: the pure resolveSignProductionWorkspaceUrl
  // gate — registered late (it was added the phase before this one and
  // missed registration then; fixed here alongside this phase's own new
  // sign-production-cta-state.test.ts).
  "src/components/chat/sign-production-bridge.test.ts",
  // Phase 27H: same "existed but was never registered" gap as the preview-
  // background inspection surface above -- the entire Magic Wand manual
  // correction system (Phase 27D-27H: session authority, the frozen
  // algorithm's own exhaustive suite, the workspace's own shape contract,
  // route-level authorization, and the real-asset acceptance test) had
  // never been part of `npm run test`/`npm run verify` at all. Found while
  // reconciling this phase's regression totals; registering it here is
  // exactly the same one-line fix used last time this happened.
  "src/experimental/magic-wand/magic-wand.test.ts",
  "src/capabilities/artwork-preparation/magic-wand-correction-capability.test.ts",
  "src/capabilities/artwork-preparation/finalize-correction-transparency.test.ts",
  "src/capabilities/artwork-preparation/incredi-bowls-manual-fallback-acceptance.test.ts",
  // Phase 27I: TOOLBOX V1 (Restore Fill, Restore Brush, Eraser) -- new
  // files registered immediately, learning from Phase 27H's discovery that
  // an unregistered test file is silently invisible to `npm run test`/
  // `npm run verify` no matter how many times it's run individually.
  "src/capabilities/artwork-preparation/correction-tools.test.ts",
  "src/capabilities/artwork-preparation/correction-toolbox-capability.test.ts",
  "src/capabilities/artwork-preparation/incredi-bowls-toolbox-acceptance.test.ts",
  // Phase 27J: operation-composition/replay regression human acceptance
  // reported on the real INCREDI-BOWLS text -- registered immediately per
  // Phase 27H/27I's own "never leave a new test file unregistered" lesson.
  "src/capabilities/artwork-preparation/operation-composition-regression.test.ts",
  "src/capabilities/artwork-preparation/incredi-bowls-operation-composition-acceptance.test.ts",
  // Phase 27K: Wand selection/apply UX-clarity regression -- registered
  // immediately per the established "never leave a new test file
  // unregistered" discipline from Phase 27H/27I/27J.
  "src/capabilities/artwork-preparation/wand-selection-apply-clarity.test.ts",
  "src/capabilities/artwork-preparation/separation-correction-authority.test.ts",
  "src/components/chat/correction-workspace-shape.test.ts",
  "src/app/api/projects/[projectId]/artwork-preparation/correction/correction-routes-authorization.test.ts",
  "src/app/api/projects/[projectId]/artwork-upload/route.test.ts",
  // Existing Artwork → Print Ready Phase 2: enhancement decision, production
  // finalization, the uploaded-preserve validation profile, and the synthetic
  // bowling end-to-end acceptance regression.
  "src/capabilities/final-artwork/enhancement-decision.test.ts",
  "src/capabilities/print-validation/uploaded-preserve-profile.test.ts",
  "src/capabilities/final-artwork-worker/prepared-upload-finalization.test.ts",
  "src/capabilities/artwork-preparation/bowling-print-ready-regression.test.ts",
  "src/lib/db/supabase-client.security.test.ts",
  "src/lib/db/security-lockdown.migration.test.ts",
  // Phase 2C0.5: paid image idempotency + spend bound hardening. Every one
  // of these counts PAID PROVIDER DISPATCHES against a local double — no
  // network, no credentials, no possibility of a real paid call.
  "src/capabilities/shared/paid-image-intent.test.ts",
  "src/capabilities/generation-worker/paid-image-idempotency.test.ts",
  "src/capabilities/providers/transport-dispatch-classification.test.ts",
  // Phase 2C: automatic hard-fail concept replacement. Palette verdicts come
  // from REAL pixels through the REAL Phase 2B validator; the provider is a
  // local double, so no paid call is possible.
  "src/capabilities/generation-worker/hard-fail-concept-replacement.test.ts",
  "src/capabilities/providers/print-palette-correction-prompt.test.ts",
  // Phase 2C.2C: failed paid-intent durability and terminal state. Written
  // against the live ordinal-4 failure shape — a billed provider response
  // whose local persistence died, leaving no durable evidence at all.
  "src/capabilities/generation-worker/paid-intent-failure-durability.test.ts",
  // Sprint A4: free-concept acquisition entitlement + email gate. The
  // entitlement matrix counts PAID PROVIDER DISPATCHES against a local
  // counting double — no network, no credentials, no possibility of a real
  // paid call — and the other three files are pure units.
  "src/capabilities/acquisition/acquisition-email.test.ts",
  "src/lib/http/acquisition-session-cookie.test.ts",
  "src/lib/config/internal-access-config.test.ts",
  "src/capabilities/acquisition/acquisition-entitlement.test.ts",
  // Sprint A4 Correction 1: acquisition spend authority. Counts PAID
  // PROVIDER DISPATCHES against a local counting double and injects failures
  // into the allocation → job → consumption sequence. The DATABASE-level
  // invariants these rely on (unique free-concept job per session, FK
  // deletion semantics) are proved separately against real PostgreSQL by
  // `scripts/verify-acquisition-authority-postgres.sql`.
  "src/capabilities/acquisition/acquisition-spend-authority.test.ts",
  // Sprint A4 Correction 2: PHYSICAL provider submissions (not just logical
  // paid intents) and the durable free-attempt tombstone. Counts real
  // dispatches against a local double that can fail ambiguously; the
  // delete-then-reinsert rejection it depends on is proved against real
  // PostgreSQL by `scripts/verify-acquisition-authority-postgres.sql`.
  "src/capabilities/acquisition/acquisition-physical-dispatch.test.ts",
  // Sprint A4 Correction C: the email gate may only appear once the free
  // concept has actually been DELIVERED. The pure condition, then the same
  // condition wired through the real customer read path against the safe
  // local provider double — no network, no paid call.
  "src/capabilities/shared/concept-delivery.test.ts",
  "src/capabilities/acquisition/acquisition-concept-delivery.test.ts",
  // Sprint A4 Correction C2: delivery is a property of the SESSION, and all
  // three surfaces that can ask for an email read one answer. Asserts
  // TRANSCRIPT CONTENT, not just `acquisition.state` — asserting state alone
  // is what let the second-project defect through Correction C's suite.
  "src/capabilities/acquisition/acquisition-session-delivery.test.ts",
  // Sprint A5.1 + A5.2: the PRODUCTION UNLOCK — the commercial entitlement,
  // keyed on the PROJECT rather than on any approval/artwork/job/asset.
  // Proves the gate itself (both finalization workflows unlocking from one
  // record), the things that must NOT unlock it (another project in the same
  // session, a mismatched session binding, an unknown profile or status), the
  // things it must NOT unlock (concept generation, an unsupported production
  // output), and that approval supersession — which fires on the customer's
  // first post-purchase revision — leaves the purchase intact.
  "src/capabilities/acquisition/production-unlock-entitlement.test.ts",
  // Sprint A5.3: checkout creation. Payment config (no silent fallback — a
  // wrong price is a billing incident, not a degraded experience), the Stripe
  // adapter against an injected fetch (never a live call), and the checkout
  // capability itself. The load-bearing assertion in the capability suite is
  // a NEGATIVE one, repeated after every successful checkout: creating a
  // payment attempt creates zero production unlocks, leaves finalization
  // refused, and moves the generation gate in neither direction.
  "src/lib/config/payment-config.test.ts",
  "src/capabilities/payment/stripe-checkout-provider.test.ts",
  "src/capabilities/payment/production-unlock-checkout.test.ts",
  "src/app/api/projects/[projectId]/production-unlock/checkout/route.test.ts",
  // Sprint A5.4: the verified webhook — the ONLY path from money to
  // entitlement. The signature matrix is the security boundary of the whole
  // sprint (constant-time compare, timestamp tolerance, multi-v1 rotation,
  // raw-bytes-not-re-serialized). The end-to-end suite drives RAW HTTP bodies
  // with real signatures through the real adapter into the real atomic
  // reconciliation, and its load-bearing assertions are the refusals: an
  // unpaid completion, a mismatched amount, a reused payment intent, and a
  // browser redirect all grant nothing.
  "src/capabilities/payment/stripe-webhook-signature.test.ts",
  "src/capabilities/payment/production-unlock-webhook.test.ts",
  "src/app/api/payments/webhook/route.test.ts",
  // Sprint A5.5: the customer-facing production unlock. The load-bearing
  // assertion is an exhaustive sweep proving the redirect hint can never
  // produce "unlocked" — only the server's entitlement can. Plus the bounded
  // confirmation poller (it must STOP), the card's negative copy checks, and
  // the whole journey end to end for both workflows with no transcript
  // commercial copy anywhere.
  "src/capabilities/payment/customer-payment-view.test.ts",
  "src/components/chat/payment-confirmation-poll.test.ts",
  "src/components/chat/ProductionUnlockCard.test.tsx",
  "src/capabilities/payment/production-unlock-customer-flow.test.ts",
  // Internal entitlement vs the commercial surface. An internal operator was
  // shown "temporarily unavailable" because the customer payment view read a
  // commercial record BEFORE it asked who was asking — so this suite pins the
  // ordering against both shapes of commercial absence (unconfigured provider
  // /price, and the reads themselves throwing) while proving the prospect
  // funnel, legacy grandfathering, and the offer itself are unchanged.
  "src/capabilities/payment/internal-entitlement-payment-view.test.ts",
  // Phase 28A: manual cleanup is now reachable from the automatic
  // background/separation review screen for an upload automatic
  // preparation never successfully ran on -- registered immediately per
  // the established discipline (Phase 27H found these previously omitted).
  "src/capabilities/artwork-preparation/manual-cleanup-from-automatic-review.test.ts",
  "src/components/chat/clean-up-manually-doorway.test.tsx",
  // Phase 28C: the false-positive separation-review fix (a tall,
  // edge-to-edge design's in-bounds proposal no longer forces a mandatory
  // review when fully removing it is provably safe) and the real
  // production/enhancement sizing fix (a confirmed garment box's height now
  // narrows production sizing, not just the placement's generic technical
  // ceiling) -- registered immediately per the established discipline.
  "src/capabilities/artwork-preparation/false-separation-review-fix.test.ts",
  "src/capabilities/print-validation/production-requirements-confirmed-box.test.ts",
  // Phase 28E: the Proposed Removal visual contract (retained artwork stays
  // full-color; only the exact proposal-mask pixels are tinted) and the
  // matching customer-facing copy/label rename -- registered immediately
  // per the established discipline.
  "src/capabilities/artwork-preparation/proposal-highlight-visual-contract.test.ts",
  "src/components/chat/separation-review-proposal-copy.test.ts",
  // Phase 28F: one consolidated customer artwork review -- the redundant
  // first-review heading/comparison/approve trio is suppressed exactly
  // when SeparationReviewPanel's own large review has a real decision to
  // show; renamed "Use Prepared/This Preparation" -> "Use This Artwork"
  // and "Remove Background Manually" -> "Edit Artwork" -- registered
  // immediately per the established discipline.
  "src/components/chat/uploaded-artwork-single-review.test.tsx",
  // Phase 28G: async review + preview state hardening -- fail-closed
  // three-state separation-check status (never optimistically shows the
  // ordinary approval review while unknown or errored), the Edit Artwork
  // doorway repositioned below the review area, an honest loading/error
  // state for the correction editor's canvas with stale-request
  // suppression, and an atomic (never partially-composited) garment-colour
  // preview swap with latest-request-wins stale-response suppression --
  // registered immediately per the established discipline.
  "src/components/chat/separation-check-status.test.ts",
  "src/components/chat/preview-image-commit.test.ts",
  "src/components/chat/garment-preview-image.test.ts",
  "src/components/chat/correction-image-load.test.ts",
  "src/components/chat/correction-workspace-loading.test.ts",
  // LIVE PRODUCT BLOCKER #4E: final_artwork_jobs.artwork_version_id was a
  // NOT NULL column with a hard FK to artwork_versions, overloaded by the
  // sign job path to carry a sign_preparations id -- the real customer's
  // first live "Prepare artwork" click failed with a Postgres FK
  // violation the entire (LocalProjectRepository-backed) test suite could
  // never have caught. Fixed by making artwork_version_id nullable and
  // routing sign identity exclusively through the existing
  // sign_preparation_id column -- registered immediately per the
  // established discipline.
  "src/lib/db/final-artwork-job-source-identity.migration.test.ts",
];
