/**
 * Signs Phase S4.2C.1: the narrow durable-state seam a transport
 * implementation with crash-recoverable bookkeeping depends on — never the
 * full `ProjectRepository` (keeps the OpenAI Files-transport adapter
 * testable against a small in-memory fake, mirroring every other provider
 * in this codebase talking to a narrow port rather than the whole
 * repository).
 */

import type { ProjectRepository } from "@/lib/db/repository";
import type { SignPreservationTransportAttempt } from "@/lib/domain/types";
import type {
  CreateSignPreservationTransportAttemptInput,
  UpdateSignPreservationTransportAttemptInput,
} from "@/lib/db/repository";

export interface SignPreservationTransportAttemptStore {
  get(
    finalAssetId: string,
    combinedVerificationAlgorithmVersion: string,
  ): Promise<SignPreservationTransportAttempt | null>;
  create(
    projectId: string,
    input: CreateSignPreservationTransportAttemptInput,
  ): Promise<SignPreservationTransportAttempt>;
  update(
    id: string,
    input: UpdateSignPreservationTransportAttemptInput,
  ): Promise<SignPreservationTransportAttempt>;
}

/** Thin adapter over the real repository — the production wiring path. */
export function createRepositoryBackedTransportAttemptStore(
  repo: ProjectRepository,
): SignPreservationTransportAttemptStore {
  return {
    get: (finalAssetId, combinedVersion) =>
      repo.getSignPreservationTransportAttempt(finalAssetId, combinedVersion),
    create: (projectId, input) => repo.createSignPreservationTransportAttempt(projectId, input),
    update: (id, input) => repo.updateSignPreservationTransportAttempt(id, input),
  };
}

/**
 * Signs Phase S4.2C.1 §10: this exact semantic-verification identity
 * already reached a terminal-or-ambiguous inference outcome that this
 * process has no recoverable answer content for — thrown instead of
 * silently re-dispatching (would risk a second paid model call) or
 * silently fabricating a result. Requires explicit human investigation.
 */
export class SignPreservationTransportAttemptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignPreservationTransportAttemptConflictError";
  }
}
