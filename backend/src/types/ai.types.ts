import type { ResumeContext } from './resume-context.js';

export type AISection = 'summary' | 'project' | 'achievement';
export type AIAction =
  | 'rewrite' | 'improve' | 'ats-optimize'
  | 'shorten' | 'expand' | 'technical' | 'beginner-friendly'
  | 'quantify' | 'action-verbs' | 'star-format'
  | 'recruiter-friendly'
  | 'extract';

export interface ImproveRequest {
  resumeProfileId: string;
  section: AISection;
  sectionItemId?: string;
  action: AIAction;
  style?: string;
}

export interface ReviewActionRequest {
  reviewId: string;
  edited?: Record<string, unknown>;
}

export interface RestoreRequest {
  profileId: string;
  revisionId: string;
}

export interface AIReviewData {
  id: string;
  resumeProfileId: string;
  section: string;
  sectionItemId: string | null;
  action: string;
  before: unknown;
  after: unknown;
  reasoning: string[];
  confidence: number | null;
  status: string;
  createdAt: string;
}

export interface ResumeRevisionData {
  id: string;
  resumeProfileId: string;
  parentRevisionId: string | null;
  label: string | null;
  createdAt: string;
  changeCount: number;
}

export interface ResumeChangePayload {
  section: string;
  sectionItemId?: string | null;
  changeType: string;
  payload: Record<string, unknown>;
}

export interface PromptContext {
  targetRole: string;
  profileName: string;
  action: AIAction;
  style?: string;
  sections: {
    summary?: { bio: string | null };
    project?: { title: string; description: string | null; techStack: string[]; bullets: string[] };
    achievement?: { title: string; description: string; icon: string };
  };
}

export interface PromptModule<T = unknown> {
  id: string;
  version: number;
  temperature: number;
  system(ctx: PromptContext): string;
  user(ctx: PromptContext): string;
  schema: import('zod').ZodType<T>;
}

export interface AIResponse<T = unknown> {
  data: T;
  raw: string;
  latencyMs: number;
  tokens?: number;
}

export interface AIProvider {
  generate<T>(prompt: PromptModule<T>, ctx: PromptContext): Promise<AIResponse<T>>;
}

export interface ResumeOverride {
  apply(context: ResumeContext, changes: ResumeChangeData[]): ResumeContext;
}

export interface ResumeChangeData {
  id: string;
  section: string;
  sectionItemId: string | null;
  changeType: string;
  payload: Record<string, unknown>;
}
