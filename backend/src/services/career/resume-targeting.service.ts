import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import type { JobContext } from '../../types/job-context.js';
import type { ResumeContext } from '../../types/resume-context.js';
import type { SimilarityScore, MatchReport, ResumeRecommendation } from '../../types/job-intelligence.types.js';
import { similarityEngine } from './match-engine/similarity-engine.js';
import { matchEngineService } from './match-engine/match-engine.service.js';
import { resumeCompositionService } from './resume-composition.service.js';

type Strategy = 'smart' | 'clone' | 'fresh';

export class ResumeTargetingService {
  async computeSimilarityScores(
    userId: string,
    jobContext: JobContext
  ): Promise<SimilarityScore[]> {
    const profiles = await prisma.resumeProfile.findMany({
      where: { careerProfile: { userId } },
      select: { id: true, name: true, targetRole: true },
    });

    if (profiles.length === 0) return [];

    const contexts = await Promise.all(
      profiles.map(p =>
        resumeCompositionService.buildResumeContext(userId, p.id).catch(() => null)
      )
    );

    const valid = profiles.filter((_, i) => contexts[i] !== null) as {
      id: string; name: string; targetRole: string;
    }[];
    const validContexts = contexts.filter(Boolean) as ResumeContext[];

    return similarityEngine.scoreProfiles(valid, validContexts, jobContext);
  }

  async createTargetedResume(
    userId: string,
    jobAnalysisId: string,
    strategy: Strategy,
    sourceProfileId?: string
  ): Promise<{
    resumeProfile: { id: string; name: string; targetRole: string };
    matchReport: MatchReport | null;
    recommendations: ResumeRecommendation[];
  }> {
    const analysis = await prisma.jobAnalysis.findUnique({ where: { id: jobAnalysisId } });
    if (!analysis) throw AppError.notFound('Job analysis not found');
    const jobContext = analysis.parsedJson as unknown as JobContext;

    const profile = await prisma.careerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) throw AppError.notFound('Career profile not found');

    let sourceProfileIdResolved = sourceProfileId;

    if (strategy === 'smart' || !sourceProfileIdResolved) {
      const scores = await this.computeSimilarityScores(userId, jobContext);
      if (scores.length > 0) {
        sourceProfileIdResolved = scores[0].profileId;
      }
    }

    let clonedProfileId: string;

    if (strategy === 'fresh' || !sourceProfileIdResolved) {
      const newProfile = await prisma.resumeProfile.create({
        data: {
          careerProfileId: profile.id,
          name: `${jobContext.metadata.company} ${jobContext.metadata.role}`,
          targetRole: jobContext.metadata.role,
          isDefault: false,
          sectionSettings: {},
        },
      });
      clonedProfileId = newProfile.id;
    } else {
      const existing = await prisma.resumeProfile.findUnique({
        where: { id: sourceProfileIdResolved },
      });
      if (!existing) throw AppError.notFound('Source profile not found');

      const cloned = await prisma.resumeProfile.create({
        data: {
          careerProfileId: profile.id,
          name: `${jobContext.metadata.company} ${jobContext.metadata.role}`,
          targetRole: jobContext.metadata.role,
          template: existing.template,
          pageSize: existing.pageSize,
          photoId: existing.photoId,
          summaryStrategy: existing.summaryStrategy,
          sectionSettings: existing.sectionSettings || {},
          isDefault: false,
        },
      });
      clonedProfileId = cloned.id;

      const existingProjects = await prisma.resumeProject.findMany({
        where: { resumeProfileId: sourceProfileIdResolved },
      });
      if (existingProjects.length > 0) {
        await prisma.resumeProject.createMany({
          data: existingProjects.map(p => ({
            resumeProfileId: clonedProfileId,
            projectId: p.projectId,
            displayOrder: p.displayOrder,
            selectedBulletIds: p.selectedBulletIds as any,
          })),
        });
      }

      const existingCerts = await prisma.resumeCertificate.findMany({
        where: { resumeProfileId: sourceProfileIdResolved },
      });
      if (existingCerts.length > 0) {
        await prisma.resumeCertificate.createMany({
          data: existingCerts.map(c => ({
            resumeProfileId: clonedProfileId,
            certificateId: c.certificateId,
            displayOrder: c.displayOrder,
          })),
        });
      }

      const existingAch = await prisma.resumeAchievement.findMany({
        where: { resumeProfileId: sourceProfileIdResolved },
      });
      if (existingAch.length > 0) {
        await prisma.resumeAchievement.createMany({
          data: existingAch.map(a => ({
            resumeProfileId: clonedProfileId,
            achievementKey: a.achievementKey,
            displayOrder: a.displayOrder,
          })),
        });
      }
    }

    const context = await resumeCompositionService.buildResumeContext(userId, clonedProfileId);
    const matchReport = matchEngineService.computeMatch(context, jobContext);

    const recommendations = this.buildRecommendations(matchReport, context, jobContext);

    return {
      resumeProfile: {
        id: clonedProfileId,
        name: `${jobContext.metadata.company} ${jobContext.metadata.role}`,
        targetRole: jobContext.metadata.role,
      },
      matchReport,
      recommendations,
    };
  }

  private buildRecommendations(
    report: MatchReport,
    context: ResumeContext,
    job: JobContext
  ): ResumeRecommendation[] {
    const recs: ResumeRecommendation[] = [];

    if (!context.sections.profile.bio || context.sections.profile.bio.length < 30) {
      recs.push({
        type: 'rewrite_summary',
        label: 'Professional Summary',
        description: 'Write a compelling summary tailored to this role.',
        confidence: 90,
        section: 'summary',
      });
    }

    const relevantProjects = report.recommendedProjects.filter(p => p.relevance >= 30);
    const irrelevantProjects = (context.sections.projects || [])
      .filter(p => !relevantProjects.some(rp => rp.projectId === p.id));

    for (const rp of relevantProjects) {
      recs.push({
        type: 'use_project',
        label: rp.title,
        description: `Highly relevant project (${rp.relevance}% match). Highlight technologies: ${rp.matchingTechnologies.join(', ')}`,
        confidence: rp.confidence,
        section: 'projects',
        sectionItemId: rp.projectId,
      });
    }

    for (const ip of irrelevantProjects.slice(0, 3)) {
      recs.push({
        type: 'remove_project',
        label: ip.title,
        description: 'Low relevance to this job. Consider removing or replacing.',
        confidence: 75,
        section: 'projects',
        sectionItemId: ip.id,
      });
    }

    const missingRequired = report.missingSkills.filter(s => s.category === 'required');
    for (const ms of missingRequired.slice(0, 5)) {
      recs.push({
        type: 'highlight_skill',
        label: ms.skill,
        description: `Required skill missing from resume. Consider adding experience with ${ms.skill}.`,
        confidence: ms.confidence,
        section: 'skills',
        payload: { skill: ms.skill },
      });
    }

    return recs;
  }
}

export const resumeTargetingService = new ResumeTargetingService();
