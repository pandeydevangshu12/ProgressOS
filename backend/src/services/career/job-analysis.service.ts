import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { PromptRegistry } from './ai/prompts/registry.js';
import { ProviderRegistry } from './ai/adapter/registry.js';
import type { JobContext } from '../../types/job-context.js';
import type { JobAnalysisData } from '../../types/job-intelligence.types.js';
import type { PromptContext } from '../../types/ai.types.js';
import { matchEngineService } from './match-engine/match-engine.service.js';
import { resumeCompositionService } from './resume-composition.service.js';

export class JobAnalysisService {
  async extract(userId: string, rawText: string): Promise<{ analysis: JobAnalysisData; context: JobContext }> {
    const prompt = PromptRegistry.get('extract', 'job');
    if (!prompt) throw AppError.internal('Extract job prompt not found');

    const promptCtx: PromptContext = {
      targetRole: '',
      profileName: '',
      action: 'extract',
      sections: {
        summary: { bio: rawText },
      },
    };

    const provider = ProviderRegistry.getDefault();
    const response = await provider.generate(prompt, promptCtx);
    const context = response.data as unknown as JobContext;

    const stored = await prisma.jobAnalysis.create({
      data: {
        userId,
        title: context.metadata.role || null,
        company: context.metadata.company || null,
        rawText,
        parsedJson: JSON.parse(response.raw) as any,
      },
    });

    return {
      analysis: this.mapToData(stored, context),
      context,
    };
  }

  async getById(id: string): Promise<{ analysis: JobAnalysisData; context: JobContext } | null> {
    const stored = await prisma.jobAnalysis.findUnique({ where: { id } });
    if (!stored) return null;

    const context = stored.parsedJson as unknown as JobContext;
    return {
      analysis: this.mapToData(stored, context),
      context,
    };
  }

  async list(userId: string, resumeProfileId?: string): Promise<JobAnalysisData[]> {
    const where: Record<string, unknown> = { userId };
    if (resumeProfileId) where.resumeProfileId = resumeProfileId;

    const stored = await prisma.jobAnalysis.findMany({
      where: where as any,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return stored.map(s => {
      const context = (s.parsedJson as unknown as JobContext) || null;
      return this.mapToData(s, context, s.resumeProfileId || undefined);
    });
  }

  async delete(id: string): Promise<void> {
    await prisma.jobAnalysis.delete({ where: { id } });
  }

  async match(
    userId: string,
    jobAnalysisId: string,
    resumeProfileId: string
  ): Promise<{ report: import('../../types/job-intelligence.types.js').MatchReport }> {
    const stored = await prisma.jobAnalysis.findUnique({ where: { id: jobAnalysisId } });
    if (!stored) throw AppError.notFound('Job analysis not found');

    const context = await resumeCompositionService.buildResumeContext(userId, resumeProfileId);
    const jobContext = stored.parsedJson as unknown as JobContext;

    const report = matchEngineService.computeMatch(context, jobContext);
    return { report };
  }

  private mapToData(
    stored: { id: string; title: string | null; company: string | null; rawText: string; createdAt: Date; resumeProfileId?: string | null },
    context: JobContext | null,
    resumeProfileId?: string
  ): JobAnalysisData {
    return {
      id: stored.id,
      title: stored.title,
      company: stored.company,
      rawText: stored.rawText,
      context: context || {
        metadata: { company: '', role: '', seniority: '', employmentType: '', location: '', remote: false, salary: null },
        requiredSkills: [],
        preferredSkills: [],
        responsibilities: [],
        keywords: [],
      },
      createdAt: stored.createdAt.toISOString?.() || String(stored.createdAt),
    };
  }
}

export const jobAnalysisService = new JobAnalysisService();
