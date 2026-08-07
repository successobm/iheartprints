import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import { emptyInterviewState } from "@/lib/domain/types";
import type {
  ArtworkVersion,
  AssetKind,
  AssetRecord,
  ConceptEvaluation,
  ConceptEvaluationStatus,
  ConversationMessage,
  ConversationPhase,
  DesignBriefVersion,
  DesignBriefVersionStatus,
  DesignConversation,
  FinalArtworkJob,
  FinalArtworkJobStatus,
  FinalDirectionApproval,
  FinalDirectionApprovalStatus,
  GenerationJob,
  GenerationJobStatus,
  InterviewStateData,
  PrintProject,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CreateArtworkVersionInput,
  CreateAssetInput,
  CreateFinalArtworkJobInput,
  CreateFinalDirectionApprovalInput,
  CreateGenerationJobInput,
  CreateMessageInput,
  ProjectRepository,
  UpdateArtworkEvaluationInput,
  UpdateGenerationJobInput,
} from "./repository";
import type { SupabaseClient } from "@supabase/supabase-js";

import { UniqueConstraintViolationError } from "./repository";
import { getSupabaseServiceClient, isSupabaseConfigured } from "./supabase-client";

type DbProject = {
  id: string;
  name: string;
  status: ProjectStatus;
  selected_artwork_version_id: string | null;
  created_at: string;
  updated_at: string;
};

type DbBrief = {
  id: string;
  project_id: string;
  customer_name: string | null;
  project_name: string | null;
  product_summary: string | null;
  design_description: string | null;
  exact_text: string | null;
  shirt_color: string | null;
  print_placement: TShirtDesignBrief["printPlacement"];
  intended_print_width_in: number | null;
  preferred_colors: string[] | null;
  design_style: string | null;
  additional_instructions: string | null;
  audience: string | null;
  purpose: string | null;
  exclusions: string | null;
  deferred_sections: string[] | null;
  created_at: string;
  updated_at: string;
};

type DbConversation = {
  id: string;
  project_id: string;
  phase: ConversationPhase;
  interview_state: InterviewStateData | null;
  created_at: string;
  updated_at: string;
};

type DbMessage = {
  id: string;
  conversation_id: string;
  project_id: string;
  role: ConversationMessage["role"];
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DbArtwork = {
  id: string;
  project_id: string;
  version_number: number;
  kind: ArtworkVersion["kind"];
  title: string;
  summary: string;
  placeholder_label: string;
  accent_color: string;
  is_selected: boolean;
  design_brief_version_id: string | null;
  generation_job_id: string | null;
  primary_asset_id: string | null;
  thumbnail_asset_id: string | null;
  provider_key: string | null;
  customer_rating: number | null;
  evaluation_status: ConceptEvaluationStatus | null;
  evaluation: ConceptEvaluation | null;
  evaluation_evaluated_at: string | null;
  evaluation_provider_key: string | null;
  print_validation_status: string | null;
  created_at: string;
};

type DbGenerationJob = {
  id: string;
  project_id: string;
  design_brief_version_id: string;
  status: GenerationJobStatus;
  kind: GenerationJob["kind"];
  concept_count: number;
  provider_key: string;
  idempotency_key: string;
  attempts: number;
  last_error: string | null;
  started_at: string | null;
  completed_at: string | null;
  heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbAsset = {
  id: string;
  project_id: string;
  kind: AssetKind;
  storage_key: string | null;
  content_type: string | null;
  is_thumbnail: boolean;
  width_px: number | null;
  height_px: number | null;
  has_transparency: boolean | null;
  provider_key: string | null;
  generation_job_id: string | null;
  metadata: Record<string, unknown> | null;
  vector_asset_id: string | null;
  print_asset_id: string | null;
  final_artwork_job_id: string | null;
  created_at: string;
};

type DbFinalDirectionApproval = {
  id: string;
  project_id: string;
  artwork_version_id: string;
  design_brief_version_id: string;
  status: FinalDirectionApprovalStatus;
  approved_at: string;
  superseded_at: string | null;
  created_at: string;
};

type DbFinalArtworkJob = {
  id: string;
  project_id: string;
  final_direction_approval_id: string;
  artwork_version_id: string;
  status: FinalArtworkJobStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type DbDesignBriefVersion = {
  id: string;
  project_id: string;
  brief_id: string;
  version_number: number;
  status: DesignBriefVersionStatus;
  content: DesignBriefVersion["content"];
  approved_at: string;
  created_at: string;
};

function mapProject(row: DbProject): PrintProject {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    selectedArtworkVersionId: row.selected_artwork_version_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBrief(row: DbBrief): TShirtDesignBrief {
  return {
    id: row.id,
    projectId: row.project_id,
    customerName: row.customer_name,
    projectName: row.project_name,
    productSummary: row.product_summary,
    designDescription: row.design_description,
    exactText: row.exact_text,
    shirtColor: row.shirt_color,
    printPlacement: row.print_placement,
    intendedPrintWidthIn: row.intended_print_width_in,
    preferredColors: row.preferred_colors ?? [],
    designStyle: row.design_style,
    additionalInstructions: row.additional_instructions,
    audience: row.audience ?? null,
    purpose: row.purpose ?? null,
    exclusions: row.exclusions ?? null,
    deferredSections: row.deferred_sections ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: DbConversation): DesignConversation {
  return {
    id: row.id,
    projectId: row.project_id,
    phase: row.phase,
    // Spread onto the full default shape (not just `??`) so a row written
    // before a new InterviewStateData field existed still gets a default
    // for it instead of `undefined`.
    interviewState: { ...emptyInterviewState(), ...row.interview_state },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: DbMessage): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    projectId: row.project_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
  };
}

function mapArtwork(row: DbArtwork): ArtworkVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    versionNumber: row.version_number,
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    placeholderLabel: row.placeholder_label,
    accentColor: row.accent_color,
    isSelected: row.is_selected,
    designBriefVersionId: row.design_brief_version_id,
    generationJobId: row.generation_job_id ?? null,
    primaryAssetId: row.primary_asset_id ?? null,
    thumbnailAssetId: row.thumbnail_asset_id ?? null,
    providerKey: row.provider_key ?? null,
    customerRating: row.customer_rating ?? null,
    evaluationStatus: row.evaluation_status ?? null,
    evaluation: row.evaluation ?? null,
    evaluationEvaluatedAt: row.evaluation_evaluated_at ?? null,
    evaluationProviderKey: row.evaluation_provider_key ?? null,
    printValidationStatus: row.print_validation_status ?? null,
    createdAt: row.created_at,
  };
}

function mapGenerationJob(row: DbGenerationJob): GenerationJob {
  return {
    id: row.id,
    projectId: row.project_id,
    designBriefVersionId: row.design_brief_version_id,
    status: row.status,
    kind: row.kind,
    conceptCount: row.concept_count,
    providerKey: row.provider_key,
    idempotencyKey: row.idempotency_key,
    attempts: row.attempts,
    lastError: row.last_error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    heartbeatAt: row.heartbeat_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAsset(row: DbAsset): AssetRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    storageKey: row.storage_key,
    contentType: row.content_type,
    isThumbnail: row.is_thumbnail,
    widthPx: row.width_px,
    heightPx: row.height_px,
    hasTransparency: row.has_transparency,
    providerKey: row.provider_key,
    generationJobId: row.generation_job_id,
    metadata: row.metadata ?? {},
    vectorAssetId: row.vector_asset_id,
    printAssetId: row.print_asset_id,
    finalArtworkJobId: row.final_artwork_job_id ?? null,
    createdAt: row.created_at,
  };
}

function mapFinalDirectionApproval(
  row: DbFinalDirectionApproval,
): FinalDirectionApproval {
  return {
    id: row.id,
    projectId: row.project_id,
    artworkVersionId: row.artwork_version_id,
    designBriefVersionId: row.design_brief_version_id,
    status: row.status,
    approvedAt: row.approved_at,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

function mapFinalArtworkJob(row: DbFinalArtworkJob): FinalArtworkJob {
  return {
    id: row.id,
    projectId: row.project_id,
    finalDirectionApprovalId: row.final_direction_approval_id,
    artworkVersionId: row.artwork_version_id,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDesignBriefVersion(row: DbDesignBriefVersion): DesignBriefVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    briefId: row.brief_id,
    versionNumber: row.version_number,
    status: row.status,
    content: row.content,
    approvedAt: row.approved_at,
    createdAt: row.created_at,
  };
}

/** Postgres unique_violation. See https://www.postgresql.org/docs/current/errcodes-appendix.html */
const POSTGRES_UNIQUE_VIOLATION = "23505";

export { isSupabaseConfigured };

export class SupabaseProjectRepository implements ProjectRepository {
  private client: SupabaseClient;

  /**
   * Sprint 2H Part 2B: accepts an injectable client (mirroring
   * `SupabaseStorageAssetProvider`) so `claimNextQueuedJob` /
   * `recoverAbandonedJobs`'s atomic-claim query shape can be unit-tested
   * against a fake Postgrest client without live Supabase infrastructure.
   * Production call sites never pass an argument.
   */
  constructor(client: SupabaseClient = getSupabaseServiceClient()) {
    this.client = client;
  }

  async createProject(): Promise<ProjectSnapshot> {
    const { data: projectRow, error: projectError } = await this.client
      .from("print_projects")
      .insert({ name: "Untitled T-shirt design", status: "intake" })
      .select("*")
      .single();
    if (projectError) throw projectError;

    const project = mapProject(projectRow as DbProject);

    const { data: briefRow, error: briefError } = await this.client
      .from("tshirt_design_briefs")
      .insert({ project_id: project.id })
      .select("*")
      .single();
    if (briefError) throw briefError;

    // Sprint 2F: new projects start in the adaptive interview lifecycle.
    // "product" is always the first question — nothing can be known yet.
    const initialInterviewState = {
      ...emptyInterviewState(),
      pendingSection: "product",
      askCounts: { product: 1 },
    };
    const { data: conversationRow, error: conversationError } =
      await this.client
        .from("design_conversations")
        .insert({
          project_id: project.id,
          phase: "interviewing",
          interview_state: initialInterviewState,
        })
        .select("*")
        .single();
    if (conversationError) throw conversationError;

    const conversation = mapConversation(conversationRow as DbConversation);

    const { data: messageRow, error: messageError } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: conversation.id,
        project_id: project.id,
        role: "assistant",
        content: OPENING_PROMPT,
        metadata: { phase: "interviewing", act: "ask", section: "product" },
      })
      .select("*")
      .single();
    if (messageError) throw messageError;

    return {
      project,
      brief: mapBrief(briefRow as DbBrief),
      conversation,
      messages: [mapMessage(messageRow as DbMessage)],
      artworkVersions: [],
      designBriefVersions: [],
    };
  }

  async getProject(projectId: string): Promise<ProjectSnapshot | null> {
    const { data: projectRow, error: projectError } = await this.client
      .from("print_projects")
      .select("*")
      .eq("id", projectId)
      .maybeSingle();
    if (projectError) throw projectError;
    if (!projectRow) return null;

    const [
      { data: briefRow },
      { data: conversationRow },
      { data: messages },
      { data: versions },
      { data: briefVersions },
    ] = await Promise.all([
      this.client
        .from("tshirt_design_briefs")
        .select("*")
        .eq("project_id", projectId)
        .single(),
      this.client
        .from("design_conversations")
        .select("*")
        .eq("project_id", projectId)
        .single(),
      this.client
        .from("conversation_messages")
        .select("*")
        .eq("project_id", projectId)
        .order("created_at", { ascending: true }),
      this.client
        .from("artwork_versions")
        .select("*")
        .eq("project_id", projectId)
        .order("version_number", { ascending: true }),
      this.client
        .from("design_brief_versions")
        .select("*")
        .eq("project_id", projectId)
        .order("version_number", { ascending: true }),
    ]);

    if (!briefRow || !conversationRow) return null;

    return {
      project: mapProject(projectRow as DbProject),
      brief: mapBrief(briefRow as DbBrief),
      conversation: mapConversation(conversationRow as DbConversation),
      messages: ((messages as DbMessage[]) ?? []).map(mapMessage),
      artworkVersions: ((versions as DbArtwork[]) ?? []).map(mapArtwork),
      designBriefVersions: ((briefVersions as DbDesignBriefVersion[]) ?? []).map(
        mapDesignBriefVersion,
      ),
    };
  }

  async updateProject(
    projectId: string,
    patch: Partial<
      Pick<PrintProject, "name" | "status" | "selectedArtworkVersionId">
    >,
  ): Promise<PrintProject> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.name !== undefined) payload.name = patch.name;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.selectedArtworkVersionId !== undefined) {
      payload.selected_artwork_version_id = patch.selectedArtworkVersionId;
    }

    const { data, error } = await this.client
      .from("print_projects")
      .update(payload)
      .eq("id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapProject(data as DbProject);
  }

  async updateBrief(
    projectId: string,
    patch: Partial<
      Omit<TShirtDesignBrief, "id" | "projectId" | "createdAt" | "updatedAt">
    >,
  ): Promise<TShirtDesignBrief> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (patch.customerName !== undefined)
      payload.customer_name = patch.customerName;
    if (patch.projectName !== undefined)
      payload.project_name = patch.projectName;
    if (patch.productSummary !== undefined)
      payload.product_summary = patch.productSummary;
    if (patch.designDescription !== undefined)
      payload.design_description = patch.designDescription;
    if (patch.exactText !== undefined) payload.exact_text = patch.exactText;
    if (patch.shirtColor !== undefined) payload.shirt_color = patch.shirtColor;
    if (patch.printPlacement !== undefined)
      payload.print_placement = patch.printPlacement;
    if (patch.intendedPrintWidthIn !== undefined)
      payload.intended_print_width_in = patch.intendedPrintWidthIn;
    if (patch.preferredColors !== undefined)
      payload.preferred_colors = patch.preferredColors;
    if (patch.designStyle !== undefined)
      payload.design_style = patch.designStyle;
    if (patch.additionalInstructions !== undefined)
      payload.additional_instructions = patch.additionalInstructions;
    if (patch.audience !== undefined) payload.audience = patch.audience;
    if (patch.purpose !== undefined) payload.purpose = patch.purpose;
    if (patch.exclusions !== undefined) payload.exclusions = patch.exclusions;
    if (patch.deferredSections !== undefined)
      payload.deferred_sections = patch.deferredSections;

    const { data, error } = await this.client
      .from("tshirt_design_briefs")
      .update(payload)
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;

    const brief = mapBrief(data as DbBrief);
    await this.updateProject(projectId, { name: projectNameFromBrief(brief) });
    return brief;
  }

  async updateConversationPhase(
    projectId: string,
    phase: ConversationPhase,
  ): Promise<DesignConversation> {
    const { data, error } = await this.client
      .from("design_conversations")
      .update({ phase, updated_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapConversation(data as DbConversation);
  }

  async updateConversationInterviewState(
    projectId: string,
    interviewState: InterviewStateData,
  ): Promise<DesignConversation> {
    const { data, error } = await this.client
      .from("design_conversations")
      .update({
        interview_state: interviewState,
        updated_at: new Date().toISOString(),
      })
      .eq("project_id", projectId)
      .select("*")
      .single();
    if (error) throw error;
    return mapConversation(data as DbConversation);
  }

  async addMessage(
    projectId: string,
    input: CreateMessageInput,
  ): Promise<ConversationMessage> {
    const { data: conversation, error: conversationError } = await this.client
      .from("design_conversations")
      .select("id")
      .eq("project_id", projectId)
      .single();
    if (conversationError) throw conversationError;

    const { data, error } = await this.client
      .from("conversation_messages")
      .insert({
        conversation_id: conversation.id,
        project_id: projectId,
        role: input.role,
        content: input.content,
        metadata: input.metadata ?? {},
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapMessage(data as DbMessage);
  }

  async addArtworkVersions(
    projectId: string,
    versions: CreateArtworkVersionInput[],
  ): Promise<ArtworkVersion[]> {
    const { data, error } = await this.client
      .from("artwork_versions")
      .insert(
        versions.map((version) => ({
          project_id: projectId,
          version_number: version.versionNumber,
          kind: version.kind,
          title: version.title,
          summary: version.summary,
          placeholder_label: version.placeholderLabel,
          accent_color: version.accentColor,
          is_selected: false,
          design_brief_version_id: version.designBriefVersionId,
          generation_job_id: version.generationJobId ?? null,
          primary_asset_id: version.primaryAssetId ?? null,
          thumbnail_asset_id: version.thumbnailAssetId ?? null,
          provider_key: version.providerKey ?? null,
          evaluation_status: version.evaluationStatus ?? null,
          evaluation: version.evaluation ?? null,
          evaluation_evaluated_at: version.evaluationEvaluatedAt ?? null,
          evaluation_provider_key: version.evaluationProviderKey ?? null,
        })),
      )
      .select("*")
      .order("version_number", { ascending: true });
    if (error) throw error;
    return ((data as DbArtwork[]) ?? []).map(mapArtwork);
  }

  async updateArtworkEvaluation(
    artworkVersionId: string,
    input: UpdateArtworkEvaluationInput,
  ): Promise<ArtworkVersion> {
    const { data, error } = await this.client
      .from("artwork_versions")
      .update({
        evaluation_status: input.evaluationStatus,
        evaluation: input.evaluation,
        evaluation_evaluated_at: input.evaluationEvaluatedAt,
        evaluation_provider_key: input.evaluationProviderKey,
      })
      .eq("id", artworkVersionId)
      .select("*")
      .single();
    if (error) throw error;
    return mapArtwork(data as DbArtwork);
  }

  async selectArtworkVersion(
    projectId: string,
    artworkVersionId: string,
  ): Promise<ProjectSnapshot> {
    await this.client
      .from("artwork_versions")
      .update({ is_selected: false })
      .eq("project_id", projectId);

    const { error: selectError } = await this.client
      .from("artwork_versions")
      .update({ is_selected: true })
      .eq("id", artworkVersionId)
      .eq("project_id", projectId);
    if (selectError) throw selectError;

    await this.updateProject(projectId, {
      selectedArtworkVersionId: artworkVersionId,
      status: "revision_requested",
    });

    const snapshot = await this.getProject(projectId);
    if (!snapshot) throw new Error("Project not found");
    return snapshot;
  }

  async setProjectStatus(
    projectId: string,
    status: ProjectStatus,
  ): Promise<PrintProject> {
    return this.updateProject(projectId, { status });
  }

  async approveDesignBrief(
    projectId: string,
    input: ApproveDesignBriefInput,
  ): Promise<DesignBriefVersion> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .insert({
        project_id: projectId,
        brief_id: input.briefId,
        version_number: input.versionNumber,
        status: "approved",
        content: input.content,
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "design_brief_versions_project_id_version_number",
        );
      }
      throw error;
    }

    return mapDesignBriefVersion(data as DbDesignBriefVersion);
  }

  async getLatestDesignBriefVersion(
    projectId: string,
  ): Promise<DesignBriefVersion | null> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .select("*")
      .eq("project_id", projectId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapDesignBriefVersion(data as DbDesignBriefVersion) : null;
  }

  async getDesignBriefVersionById(
    versionId: string,
  ): Promise<DesignBriefVersion | null> {
    const { data, error } = await this.client
      .from("design_brief_versions")
      .select("*")
      .eq("id", versionId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapDesignBriefVersion(data as DbDesignBriefVersion) : null;
  }

  // --- Sprint 2H Part 1: generation jobs -----------------------------

  async createGenerationJob(
    projectId: string,
    input: CreateGenerationJobInput,
  ): Promise<GenerationJob> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .insert({
        project_id: projectId,
        design_brief_version_id: input.designBriefVersionId,
        status: "queued",
        kind: input.kind,
        concept_count: input.conceptCount,
        provider_key: input.providerKey,
        idempotency_key: input.idempotencyKey,
        attempts: 0,
      })
      .select("*")
      .single();

    if (error) {
      // Idempotent retry: a concurrent/duplicate call raced us to create
      // the same (project, approved version) job. Return the winner's row
      // rather than erroring, mirroring `approveDesignBrief`'s pattern.
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        const existing = await this.getGenerationJobByIdempotencyKey(
          projectId,
          input.idempotencyKey,
        );
        if (existing) return existing;
      }
      throw error;
    }

    return mapGenerationJob(data as DbGenerationJob);
  }

  async getGenerationJobByIdempotencyKey(
    projectId: string,
    idempotencyKey: string,
  ): Promise<GenerationJob | null> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async getGenerationJob(jobId: string): Promise<GenerationJob | null> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async listGenerationJobs(projectId: string): Promise<GenerationJob[]> {
    const { data, error } = await this.client
      .from("generation_jobs")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbGenerationJob[]) ?? []).map(mapGenerationJob);
  }

  async updateGenerationJob(
    jobId: string,
    patch: UpdateGenerationJobInput,
  ): Promise<GenerationJob> {
    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.attempts !== undefined) payload.attempts = patch.attempts;
    if (patch.lastError !== undefined) payload.last_error = patch.lastError;
    if (patch.startedAt !== undefined) payload.started_at = patch.startedAt;
    if (patch.completedAt !== undefined) payload.completed_at = patch.completedAt;
    if (patch.heartbeatAt !== undefined) payload.heartbeat_at = patch.heartbeatAt;

    const { data, error } = await this.client
      .from("generation_jobs")
      .update(payload)
      .eq("id", jobId)
      .select("*")
      .single();
    if (error) throw error;
    return mapGenerationJob(data as DbGenerationJob);
  }

  // --- Sprint 2H Part 2A: background worker ---------------------------

  async claimNextQueuedJob(): Promise<GenerationJob | null> {
    // Optimistic claim: read the oldest due candidate, then update it
    // conditioned on it still being in the status we read — if a
    // concurrent claimant won the race, the conditional update touches
    // zero rows and we simply report "nothing claimed" rather than
    // retrying, which is safe (the caller's next tick tries again).
    const { data: candidate, error: candidateError } = await this.client
      .from("generation_jobs")
      .select("*")
      .in("status", ["queued", "recoverable"])
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (candidateError) throw candidateError;
    if (!candidate) return null;

    const row = candidate as DbGenerationJob;
    const timestamp = new Date().toISOString();

    const { data, error } = await this.client
      .from("generation_jobs")
      .update({
        status: "running",
        attempts: row.attempts + 1,
        started_at: timestamp,
        heartbeat_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? mapGenerationJob(data as DbGenerationJob) : null;
  }

  async touchGenerationJobHeartbeat(jobId: string): Promise<void> {
    const { error } = await this.client
      .from("generation_jobs")
      .update({ heartbeat_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) throw error;
  }

  async recoverAbandonedJobs(staleAfterMs: number): Promise<GenerationJob[]> {
    const staleBefore = new Date(Date.now() - staleAfterMs).toISOString();

    // Sprint 2H Part 2B: a single atomic conditional UPDATE — no
    // select-then-write gap. The earlier version selected stale candidates
    // first and then unconditionally flipped exactly those row IDs to
    // "recoverable", which meant a job that legitimately heartbeated (or
    // even completed) in the gap between the SELECT and the UPDATE would
    // still get recovered — a second worker could then claim and re-run a
    // job that was never actually abandoned, producing a duplicate
    // concept batch. Folding the staleness filter directly into the
    // UPDATE's WHERE clause means Postgres evaluates it against each row's
    // *current* state at commit time, so a job is recovered "only once":
    // any legitimate heartbeat or completion between when this query was
    // issued and when it executes excludes that row from the update,
    // exactly like `claimNextQueuedJob`'s conditional claim.
    const { data, error } = await this.client
      .from("generation_jobs")
      .update({ status: "recoverable", updated_at: new Date().toISOString() })
      .eq("status", "running")
      .or(
        `and(heartbeat_at.is.null,started_at.lt.${staleBefore}),heartbeat_at.lt.${staleBefore}`,
      )
      .select("*");
    if (error) throw error;

    return ((data as DbGenerationJob[]) ?? []).map(mapGenerationJob);
  }

  // --- Sprint 2H Part 1: assets ---------------------------------------

  async createAsset(
    projectId: string,
    input: CreateAssetInput,
  ): Promise<AssetRecord> {
    const { data, error } = await this.client
      .from("assets")
      .insert({
        project_id: projectId,
        kind: input.kind,
        storage_key: input.storageKey,
        content_type: input.contentType,
        is_thumbnail: input.isThumbnail,
        width_px: input.widthPx,
        height_px: input.heightPx,
        has_transparency: input.hasTransparency,
        provider_key: input.providerKey,
        generation_job_id: input.generationJobId,
        metadata: input.metadata,
        vector_asset_id: input.vectorAssetId,
        print_asset_id: input.printAssetId,
        final_artwork_job_id: input.finalArtworkJobId,
      })
      .select("*")
      .single();
    if (error) throw error;
    return mapAsset(data as DbAsset);
  }

  async listAssets(projectId: string): Promise<AssetRecord[]> {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return ((data as DbAsset[]) ?? []).map(mapAsset);
  }

  async getAssetById(assetId: string): Promise<AssetRecord | null> {
    const { data, error } = await this.client
      .from("assets")
      .select("*")
      .eq("id", assetId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapAsset(data as DbAsset) : null;
  }

  async deleteAsset(assetId: string): Promise<void> {
    const { error } = await this.client.from("assets").delete().eq("id", assetId);
    if (error) throw error;
  }

  // --- Sprint 2M Phase 2B: final direction approval + final artwork job ---

  async createFinalDirectionApproval(
    projectId: string,
    input: CreateFinalDirectionApprovalInput,
  ): Promise<FinalDirectionApproval> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .insert({
        project_id: projectId,
        artwork_version_id: input.artworkVersionId,
        design_brief_version_id: input.designBriefVersionId,
        status: "active",
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "final_direction_approvals_active_per_project",
        );
      }
      throw error;
    }

    return mapFinalDirectionApproval(data as DbFinalDirectionApproval);
  }

  async getActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .select("*")
      .eq("project_id", projectId)
      .eq("status", "active")
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapFinalDirectionApproval(data as DbFinalDirectionApproval)
      : null;
  }

  async supersedeActiveFinalDirectionApproval(
    projectId: string,
  ): Promise<FinalDirectionApproval | null> {
    const { data, error } = await this.client
      .from("final_direction_approvals")
      .update({ status: "superseded", superseded_at: new Date().toISOString() })
      .eq("project_id", projectId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data
      ? mapFinalDirectionApproval(data as DbFinalDirectionApproval)
      : null;
  }

  async createFinalArtworkJob(
    projectId: string,
    input: CreateFinalArtworkJobInput,
  ): Promise<FinalArtworkJob> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .insert({
        project_id: projectId,
        final_direction_approval_id: input.finalDirectionApprovalId,
        artwork_version_id: input.artworkVersionId,
        status: "queued",
      })
      .select("*")
      .single();

    if (error) {
      if (error.code === POSTGRES_UNIQUE_VIOLATION) {
        throw new UniqueConstraintViolationError(
          "final_artwork_jobs_project_id_final_direction_approval_id",
        );
      }
      throw error;
    }

    return mapFinalArtworkJob(data as DbFinalArtworkJob);
  }

  async getFinalArtworkJobByApprovalId(
    projectId: string,
    finalDirectionApprovalId: string,
  ): Promise<FinalArtworkJob | null> {
    const { data, error } = await this.client
      .from("final_artwork_jobs")
      .select("*")
      .eq("project_id", projectId)
      .eq("final_direction_approval_id", finalDirectionApprovalId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapFinalArtworkJob(data as DbFinalArtworkJob) : null;
  }
}
