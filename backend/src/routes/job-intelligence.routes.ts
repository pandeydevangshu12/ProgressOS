import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { AuthenticatedRequest } from '../types/index.js';
import { jobIntelligenceController } from '../controllers/career-studio/job-intelligence.controller.js';

const router = Router();

router.post('/extract', requireAuth, (req, res, next) =>
  jobIntelligenceController.extract(req as AuthenticatedRequest, res, next)
);

router.post('/match', requireAuth, (req, res, next) =>
  jobIntelligenceController.match(req as AuthenticatedRequest, res, next)
);

router.post('/similarity-scores', requireAuth, (req, res, next) =>
  jobIntelligenceController.similarityScores(req as AuthenticatedRequest, res, next)
);

router.post('/create-resume-strategy', requireAuth, (req, res, next) =>
  jobIntelligenceController.createResumeStrategy(req as AuthenticatedRequest, res, next)
);

router.get('/analyses', requireAuth, (req, res, next) =>
  jobIntelligenceController.list(req as AuthenticatedRequest, res, next)
);

router.get('/analyses/:id', requireAuth, (req, res, next) =>
  jobIntelligenceController.getById(req as AuthenticatedRequest, res, next)
);

router.delete('/analyses/:id', requireAuth, (req, res, next) =>
  jobIntelligenceController.delete(req as AuthenticatedRequest, res, next)
);

export default router;
