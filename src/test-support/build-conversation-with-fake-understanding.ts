import { createConversationCapability } from "@/capabilities/conversation";
import type { ConversationCapability } from "@/capabilities/conversation";
import { createConversationUnderstandingCapability } from "@/capabilities/conversation-understanding";

import {
  FakeConversationUnderstandingProvider,
  type FakeUnderstandingRule,
} from "./fake-conversation-understanding-provider";

/**
 * Builds a full `ConversationCapability` from the real peer capabilities
 * (`createCapabilityGraph`), swapping in a scripted
 * `FakeConversationUnderstandingProvider` in place of a real LLM — no
 * network calls. Every other capability (Intent Extraction, Design Brief,
 * Brief Evaluation, Interview Intelligence, ...) is the genuine production
 * wiring, so a passing test here exercises the real pipeline end to end.
 *
 * Callers are responsible for `resetCapabilityGraphForTests()` /
 * `resetProjectRepositoryForTests()` and an isolated `process.cwd()` (a
 * temp dir) before calling this, exactly like any other local-store test.
 */
export async function buildConversationWithFakeUnderstanding(
  rules: FakeUnderstandingRule[] = [],
  options: { failWith?: unknown } = {},
): Promise<{
  conversation: ConversationCapability;
  fake: FakeConversationUnderstandingProvider;
}> {
  const { createCapabilityGraph } = await import("@/capabilities/composition");
  const { getProjectRepository } = await import("@/lib/db");

  const repo = getProjectRepository();
  const graph = createCapabilityGraph(repo);
  const fake = new FakeConversationUnderstandingProvider({ rules, ...options });
  const conversationUnderstanding = createConversationUnderstandingCapability(fake);

  const conversation = createConversationCapability({
    repo,
    intentExtraction: graph.intentExtraction,
    conversationUnderstanding,
    designBrief: graph.designBrief,
    briefEvaluation: graph.briefEvaluation,
    designIntelligence: graph.designIntelligence,
    interviewIntelligence: graph.interviewIntelligence,
    revisionIntelligence: graph.revisionIntelligence,
    designSummary: graph.designSummary,
    conceptGeneration: graph.conceptGeneration,
    finalArtwork: graph.finalArtwork,
  });

  return { conversation, fake };
}
