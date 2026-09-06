import type { JobContext } from './job-context.js';

export interface SectionScore {
  score: number;
  total: number;
  matched: number;
}

export interface MissingSkill {
  skill: string;
  category: 'required' | 'preferred';
  priority: 'high' | 'medium' | 'low';
  confidence: number;
}

export interface RecommendedProject {
  projectId: string;
  title: string;
  relevance: number;
  confidence: number;
  matchingTechnologies: string[];
}

export interface RecommendedCertificate {
  certificateId: string;
  name: string;
  relevance: number;
}

export interface KeywordHeatmapItem {
  term: string;
  count: number;
  inResume: boolean;
}

export interface MatchReport {
  overall: number;
  sections: Record<string, SectionScore>;
  missingSkills: MissingSkill[];
  recommendedProjects: RecommendedProject[];
  recommendedCertificates: RecommendedCertificate[];
  keywordHeatmap: KeywordHeatmapItem[];
  warnings: string[];
}

export interface SimilarityScore {
  profileId: string;
  profileName: string;
  score: number;
  breakdown: Record<string, number>;
}

export interface ResumeRecommendation {
  type: 'use_project' | 'remove_project' | 'highlight_skill' | 'rewrite_summary' | 'quantify_project' | 'add_skill';
  label: string;
  description: string;
  confidence: number;
  section: string;
  sectionItemId?: string;
  payload?: Record<string, unknown>;
}

export interface JobAnalysisData {
  id: string;
  title: string | null;
  company: string | null;
  rawText: string;
  context: JobContext;
  matchReport?: MatchReport;
  createdAt: string;
}
