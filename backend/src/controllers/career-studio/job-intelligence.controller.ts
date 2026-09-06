import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';
import { sendSuccess } from '../../utils/response.js';
import { jobAnalysisService } from '../../services/career/job-analysis.service.js';
import { resumeTargetingService } from '../../services/career/resume-targeting.service.js';
import { AppError } from '../../utils/AppError.js';

export class JobIntelligenceController {
  async extract(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { rawText } = req.body as { rawText: string };
      if (!rawText || typeof rawText !== 'string' || rawText.trim().length < 20) {
        throw AppError.badRequest('Job description must be at least 20 characters');
      }
      const result = await jobAnalysisService.extract(req.dbUserId!, rawText.trim());
      sendSuccess(res, result);
    } catch (error) { next(error); }
  }

  async match(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { jobAnalysisId, resumeProfileId } = req.body as { jobAnalysisId: string; resumeProfileId: string };
      if (!jobAnalysisId || !resumeProfileId) {
        throw AppError.badRequest('jobAnalysisId and resumeProfileId are required');
      }
      const result = await jobAnalysisService.match(req.dbUserId!, jobAnalysisId, resumeProfileId);
      sendSuccess(res, result);
    } catch (error) { next(error); }
  }

  async similarityScores(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { jobAnalysisId } = req.body as { jobAnalysisId: string };
      if (!jobAnalysisId) throw AppError.badRequest('jobAnalysisId is required');

      const analysis = await jobAnalysisService.getById(jobAnalysisId);
      if (!analysis) throw AppError.notFound('Job analysis not found');

      const scores = await resumeTargetingService.computeSimilarityScores(
        req.dbUserId!,
        analysis.context
      );
      sendSuccess(res, { scores });
    } catch (error) { next(error); }
  }

  async createResumeStrategy(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { jobAnalysisId, strategy, sourceProfileId } = req.body as {
        jobAnalysisId: string;
        strategy: 'smart' | 'clone' | 'fresh';
        sourceProfileId?: string;
      };
      if (!jobAnalysisId || !strategy) {
        throw AppError.badRequest('jobAnalysisId and strategy are required');
      }
      if (!['smart', 'clone', 'fresh'].includes(strategy)) {
        throw AppError.badRequest('strategy must be smart, clone, or fresh');
      }

      const result = await resumeTargetingService.createTargetedResume(
        req.dbUserId!,
        jobAnalysisId,
        strategy,
        sourceProfileId
      );
      sendSuccess(res, result);
    } catch (error) { next(error); }
  }

  async list(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const resumeProfileId = req.query.resumeProfileId as string | undefined;
      const analyses = await jobAnalysisService.list(req.dbUserId!, resumeProfileId);
      sendSuccess(res, { analyses });
    } catch (error) { next(error); }
  }

  async getById(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as { id: string };
      const result = await jobAnalysisService.getById(id);
      if (!result) throw AppError.notFound('Job analysis not found');
      sendSuccess(res, result);
    } catch (error) { next(error); }
  }

  async delete(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params as { id: string };
      await jobAnalysisService.delete(id);
      sendSuccess(res, { status: 'deleted' });
    } catch (error) { next(error); }
  }
}

export const jobIntelligenceController = new JobIntelligenceController();
