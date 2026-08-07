import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { cleanupTempWorkspace } from "@/test-support/cleanup-temp-workspace";
import type { ConversationCapability } from "@/capabilities/conversation";
import type { BriefSectionKey, DesignSummaryView } from "@/capabilities/shared/contracts";
import type { ProjectSnapshot } from "@/lib/domain/types";

/**
 * Sprint 2K Phase 3 (Goal 10) — general-purpose regression coverage beyond
 * the "My 3 Sons" bowling scenario, so the extraction/normalization/
 * inspiration-vs-content/concept-differentiation engine is proven general
 * rather than overfit to one motivating example.
 *
 * Each scenario drives the real adaptive interview end-to-end
 * (deterministically, no LLM, no real provider) and checks:
 *   - product / audience / purpose stay isolated from one another
 *   - required wording is captured exactly
 *   - a stylistic reference is separated from literal content when present
 *   - "no preference" defers rather than becoming a literal color
 *   - the approved brief still yields three distinct concept directions
 *     through the real Prompt Translation → provider-neutral pipeline
 */
describe("Regression — general-purpose scenarios beyond bowling (Goal 10)", () => {
  let tempDir = "";
  let previousCwd = "";

  before(() => {
    previousCwd = process.cwd();
    tempDir = mkdtempSync(path.join(tmpdir(), "iheartprints-multi-scenario-regression-"));
    process.chdir(tempDir);
  });

  after(async () => {
    await cleanupTempWorkspace(tempDir, previousCwd);
  });

  async function freshConversation(): Promise<ConversationCapability> {
    const { resetCapabilityGraphForTests, getCapabilityGraph } = await import(
      "@/capabilities/composition"
    );
    resetCapabilityGraphForTests();
    return getCapabilityGraph().conversation;
  }

  const DEFAULT_REPLY = "You choose.";
  const MAX_TURNS = 20;

  async function driveToSummary(
    conversation: ConversationCapability,
    projectId: string,
    snapshotAfterOpener: ProjectSnapshot,
    answers: Partial<Record<BriefSectionKey, string>>,
  ): Promise<ProjectSnapshot> {
    let snapshot = snapshotAfterOpener;
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (snapshot.conversation.phase === "awaiting_summary_confirmation") {
        return snapshot;
      }
      const pending = snapshot.conversation.interviewState.pendingSection as
        | BriefSectionKey
        | null;
      const reply = (pending && answers[pending]) || DEFAULT_REPLY;
      snapshot = await conversation.handleUserMessage(projectId, reply);
    }
    throw new Error(
      `Did not reach the Design Summary within ${MAX_TURNS} turns (stuck in ` +
        `"${snapshot.conversation.phase}", pending "${snapshot.conversation.interviewState.pendingSection}")`,
    );
  }

  interface Scenario {
    name: string;
    opener: string;
    answers: Partial<Record<BriefSectionKey, string>>;
    expectedProductPattern: RegExp;
    expectedAudiencePattern?: RegExp;
    expectedPurposePattern?: RegExp;
    expectedRequiredWording: string;
    expectInspiration?: boolean;
  }

  const scenarios: Scenario[] = [
    {
      name: "Rivera Plumbing — vintage workwear shirt logo",
      opener: "Make a shirt logo for Rivera Plumbing, vintage workwear style.",
      answers: {
        graphics: "A wrench and pipe emblem, vintage workwear feel",
        productColor: "Navy",
        requiredWording: "Rivera Plumbing",
        audience: "Plumbing customers",
        purpose: "Company promotional apparel",
        printLocation: "Left chest",
        colors: "no preference",
      },
      expectedProductPattern: /t-?shirts?/i,
      expectedRequiredWording: "Rivera Plumbing",
    },
    {
      name: "Lincoln Elementary Fun Run — school fundraiser",
      opener: "We need a fun design for Lincoln Elementary Fun Run.",
      answers: {
        product: "T-shirts",
        graphics: "Running shoes and a sun, playful and colorful",
        productColor: "Yellow",
        requiredWording: "Lincoln Elementary Fun Run",
        audience: "Elementary school families",
        purpose: "School fundraiser",
        printLocation: "Full front",
        colors: "no preference",
      },
      expectedProductPattern: /t-?shirts?/i,
      expectedAudiencePattern: /elementary school families/i,
      expectedPurposePattern: /school fundraiser/i,
      expectedRequiredWording: "Lincoln Elementary Fun Run",
    },
    {
      name: "Johnson Family Reunion 2026 — outdoors/camping theme",
      opener: "Johnson Family Reunion 2026, outdoors/camping theme.",
      answers: {
        product: "T-shirts",
        graphics: "A pine tree and campfire, inspired by vintage national park posters",
        productColor: "Forest Green",
        requiredWording: "Johnson Family Reunion 2026",
        audience: "Extended family",
        purpose: "Family reunion",
        printLocation: "Full back",
        colors: "no preference",
      },
      expectedProductPattern: /t-?shirts?/i,
      expectedRequiredWording: "Johnson Family Reunion 2026",
      expectInspiration: true,
    },
    {
      name: "Tony's Pizza crew shirts — old-school pizzeria look",
      opener: "Tony's Pizza crew shirts, old-school pizzeria look.",
      answers: {
        graphics: "A pizza slice and chef's hat, old-school pizzeria look",
        productColor: "Red",
        requiredWording: "Tony's Pizza",
        audience: "Restaurant crew",
        purpose: "Staff uniform",
        printLocation: "Full back",
        colors: "no preference",
      },
      expectedProductPattern: /t-?shirts?/i,
      expectedRequiredWording: "Tony's Pizza",
    },
  ];

  for (const scenario of scenarios) {
    it(`${scenario.name}: reaches an approvable, isolated Design Summary`, async () => {
      const conversation = await freshConversation();
      const started = await conversation.start();
      const projectId = started.project.id;

      const afterOpener = await conversation.handleUserMessage(projectId, scenario.opener);
      const afterSummary = await driveToSummary(
        conversation,
        projectId,
        afterOpener,
        scenario.answers,
      );

      assert.equal(afterSummary.conversation.phase, "awaiting_summary_confirmation");
      const lastMessage = afterSummary.messages.at(-1);
      const summary = lastMessage?.metadata.summary as DesignSummaryView | undefined;
      assert.ok(summary, `${scenario.name}: expected a Design Summary`);

      // --- Product isolation -----------------------------------------
      assert.match(String(summary!.product ?? ""), scenario.expectedProductPattern);
      // Product must never absorb the purpose/audience answer text.
      assert.doesNotMatch(
        String(summary!.product ?? ""),
        /fundraiser|reunion|crew|customers|families/i,
      );

      // --- Audience / purpose isolation ---------------------------------
      // Sprint 2L Phase 1B: audience/purpose are optional-tier — never
      // proactively asked (see interview-coverage-policy.ts), so these
      // short openers alone do not necessarily establish them. When
      // present at all (customer-volunteered or contextually inferred),
      // they must still stay correctly isolated from each other and from
      // product; when absent, that is itself the expected, non-blocking
      // behavior (Goal 3: Brief Completeness ≠ Generation Readiness).
      if (scenario.expectedAudiencePattern && afterSummary.brief.audience) {
        assert.match(afterSummary.brief.audience, scenario.expectedAudiencePattern);
      }
      if (scenario.expectedPurposePattern && afterSummary.brief.purpose) {
        assert.match(afterSummary.brief.purpose, scenario.expectedPurposePattern);
      }
      // Audience and purpose must never collapse into each other.
      if (afterSummary.brief.audience && afterSummary.brief.purpose) {
        assert.notEqual(afterSummary.brief.audience, afterSummary.brief.purpose);
      }

      // --- Required wording: exact, never paraphrased -----------------
      assert.equal(summary!.requiredWording, scenario.expectedRequiredWording);

      // --- Artwork colors: never asked, never invented -----------------
      // Sprint 2L Phase 1B: colors is optional-tier — since none of these
      // openers volunteer a color preference, it simply never gets asked
      // or resolved, with no forced "you choose" deferral required to
      // reach an approvable summary.
      assert.equal(summary!.colors, undefined);
      assert.deepEqual(afterSummary.brief.preferredColors, []);

      // --- Approve and confirm concept-direction differentiation -------
      const approved = await conversation.submitDesignBriefDecision(projectId, "approve");
      const approvedVersion = approved.designBriefVersions.at(-1);
      assert.ok(approvedVersion);

      const { createPromptTranslationCapability } = await import(
        "@/capabilities/prompt-translation/prompt-translation-capability"
      );
      const { createInitialGenerationIntent } = await import(
        "@/capabilities/prompt-translation/generation-intent"
      );
      const { CONCEPT_DIRECTIONS, describeConceptDirection } = await import(
        "@/lib/domain/concept-directions"
      );

      const translation = createPromptTranslationCapability();
      const request = translation.translate(
        createInitialGenerationIntent(approvedVersion!.content),
      );

      // Required wording and unrequested-text policy carry through exactly.
      assert.equal(request.requiredWording, scenario.expectedRequiredWording);
      assert.equal(request.allowAdditionalText, false);

      if (scenario.expectInspiration) {
        assert.ok(
          request.inspirationReferences.length > 0,
          `${scenario.name}: expected a stylistic reference to be separated from content`,
        );
      }

      // Three distinct, deterministic concept directions for this brief —
      // never bowling-specific, always the same shared catalog.
      const descriptions = CONCEPT_DIRECTIONS.map((direction) =>
        describeConceptDirection(direction, request),
      );
      assert.equal(descriptions.length, 3);
      assert.equal(new Set(descriptions).size, 3);
      for (const description of descriptions) {
        assert.match(description, new RegExp(scenario.expectedRequiredWording.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  }
});
