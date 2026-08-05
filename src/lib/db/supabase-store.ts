import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  OPENING_PROMPT,
  projectNameFromBrief,
} from "@/lib/domain/conversation";
import { emptyInterviewState } from "@/lib/domain/types";
import type {
  ArtworkVersion,
  ConversationMessage,
  ConversationPhase,
  DesignBriefVersion,
  DesignBriefVersionStatus,
  DesignConversation,
  InterviewStateData,
  PrintProject,
  ProjectSnapshot,
  ProjectStatus,
  TShirtDesignBrief,
} from "@/lib/domain/types";
import type {
  ApproveDesignBriefInput,
  CreateArtworkVersionInput,
  CreateMessageInput,
  ProjectRepository,
} from "./repository";
import { UniqueConstraintViolationError } from "./repository";

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
  created_at: string;
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
    createdAt: row.created_at,
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

function getServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error("Supabase environment variables are not configured");
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  );
}

export class SupabaseProjectRepository implements ProjectRepository {
  private client = getServiceClient();

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
        })),
      )
      .select("*")
      .order("version_number", { ascending: true });
    if (error) throw error;
    return ((data as DbArtwork[]) ?? []).map(mapArtwork);
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
}
