import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { getWorkerEnv } from './config/workerEnv.js';
import { clerkMiddleware, requireAuth } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { resumeCompositionController } from './controllers/career-studio/resume-composition.controller.js';
import { AuthenticatedRequest } from './types/index.js';
import { getStorageService } from './services/storage/storage.service.js';

import userRoutes from './routes/user.routes.js';
import activityRoutes from './routes/activity.routes.js';
import dashboardRoutes from './routes/dashboard.routes.js';
import goalRoutes from './routes/goal.routes.js';
import codeforcesIntegrationRoutes from './integrations/codeforces/codeforces.routes.js';
import leetcodeIntegrationRoutes from './integrations/leetcode/leetcode.routes.js';
import githubIntegrationRoutes from './integrations/github/github.routes.js';
import marketReadinessRoutes from './routes/market-readiness.routes.js';
import insightsRoutes from './routes/insights.routes.js';
import weeklyReviewRoutes from './routes/weekly-review.routes.js';
import timelineRoutes from './routes/timeline.routes.js';
import analyticsRoutes from './routes/analytics.routes.js';
import publicProfileRoutes from './routes/public-profile.routes.js';
import achievementsRoutes from './routes/achievements.routes.js';
import vitRoutes from './integrations/vit/vit.routes.js';
import reportRoutes from './routes/report.routes.js';
import { createTrackerRouter } from './utils/trackerFactory.js';
import gateSyllabusRoutes from './routes/gateSyllabus.routes.js';
import careerStudioRoutes from './routes/career-studio.routes.js';
import careerIntelligenceRoutes from './routes/career-intelligence.routes.js';
import jobIntelligenceRoutes from './routes/job-intelligence.routes.js';

const app = express();

// ─── Global Middleware ───────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: env.NODE_ENV === 'production' && process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL
      : '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// Clerk middleware — must be applied before any route that uses requireAuth
app.use((req, res, next) => {
  const workerEnv = getWorkerEnv();
  const secretKey =
    process.env.CLERK_SECRET_KEY ||
    (workerEnv?.CLERK_SECRET_KEY as string) ||
    '';
  const publishableKey =
    process.env.CLERK_PUBLISHABLE_KEY ||
    (workerEnv?.CLERK_PUBLISHABLE_KEY as string) ||
    '';

  return clerkMiddleware({
    secretKey,
    publishableKey,
  })(req, res, next);
});

// ─── Rate Limiting ───────────────────────────────────────────────────────────

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, please try again later.' },
});

app.use('/api/', apiLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many authentication attempts, please try again later.' },
});

app.use('/api/user/', authLimiter);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    },
  });
});

// Also support /api/health
app.get('/api/health', (_req, res) => {
  res.status(200).json({
    success: true,
    data: {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    },
  });
});

// ─── Career Studio Routes ────────────────────────────────────────────────────

app.use('/api/career-studio', careerStudioRoutes);
app.use('/api/career-intelligence', careerIntelligenceRoutes);
app.use('/api/job-intelligence', jobIntelligenceRoutes);

// ─── Project Bullet Routes ───────────────────────────────────────────────────

const bulletRouter = Router();

bulletRouter.get('/:projectId/bullets', requireAuth, (req, res, next) =>
  resumeCompositionController.listBullets(req as AuthenticatedRequest, res, next)
);

bulletRouter.post('/:projectId/bullets', requireAuth, (req, res, next) =>
  resumeCompositionController.createBullet(req as AuthenticatedRequest, res, next)
);

bulletRouter.put('/:projectId/bullets/:bulletId', requireAuth, (req, res, next) =>
  resumeCompositionController.updateBullet(req as AuthenticatedRequest, res, next)
);

bulletRouter.delete('/:projectId/bullets/:bulletId', requireAuth, (req, res, next) =>
  resumeCompositionController.deleteBullet(req as AuthenticatedRequest, res, next)
);

bulletRouter.put('/:projectId/bullets/reorder', requireAuth, (req, res, next) =>
  resumeCompositionController.reorderBullets(req as AuthenticatedRequest, res, next)
);

app.use('/api/trackers/projects', bulletRouter);

// ─── Core API Routes ─────────────────────────────────────────────────────────

app.use('/api/user', userRoutes);
app.use('/api/activities', activityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/codeforces', codeforcesIntegrationRoutes);
app.use('/api/leetcode', leetcodeIntegrationRoutes);
app.use('/api/github', githubIntegrationRoutes);
app.use('/api/goals', goalRoutes);
app.use('/api/market-readiness', marketReadinessRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/weekly-review', weeklyReviewRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/public/profile', publicProfileRoutes);
app.use('/api/achievements', achievementsRoutes);
app.use('/api/vit', vitRoutes);
app.use('/api/reports', reportRoutes);

// Register Tracker Routes using the Generic Factory
app.use('/api/trackers/leetcode', createTrackerRouter('leetCodeEntry'));
app.use('/api/trackers/codeforces', createTrackerRouter('codeforcesEntry'));
app.use('/api/trackers/cgpa', createTrackerRouter('cGPAEntry'));
app.use('/api/trackers/subjects', createTrackerRouter('subjectEntry'));
app.use('/api/trackers/projects', createTrackerRouter('projectEntry'));
app.use('/api/trackers/opensource', createTrackerRouter('openSourceEntry'));
app.use('/api/trackers/corecs', createTrackerRouter('coreCSEntry'));
app.use('/api/trackers/nptel', createTrackerRouter('nPTELEntry'));
app.use('/api/trackers/aiml', createTrackerRouter('aIMLEntry'));
app.use('/api/trackers/cyber', createTrackerRouter('cyberEntry'));
app.use('/api/trackers/gate', createTrackerRouter('gATEEntry'));
app.use('/api/gate/syllabus', gateSyllabusRoutes);
app.use('/api/trackers/research', createTrackerRouter('researchEntry'));

// ─── Photo Retrieval Streaming (Disk + Cloudinary) ───────────────────────────

const handlePhotoStream = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const rawKey = req.params.storageKey;
    const storageKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!storageKey || typeof storageKey !== 'string' || storageKey.includes('..') || storageKey.includes('/') || storageKey.includes('\\')) {
      res.status(400).json({ success: false, error: 'Invalid storage key' });
      return;
    }

    const storage = getStorageService();
    const file = await storage.get(storageKey);
    if (!file) {
      res.status(404).json({ success: false, error: 'Photo not found' });
      return;
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (file.size) {
      res.setHeader('Content-Length', file.size.toString());
    }

    res.send(file.data);
  } catch (err) {
    next(err);
  }
};

app.get('/uploads/photos/:storageKey', handlePhotoStream);
app.get('/api/photos/:storageKey', handlePhotoStream);

// ─── API 404 Catch-All ───────────────────────────────────────────────────────

app.use('/api', (_req, res) => {
  res.status(404).json({
    success: false,
    error: 'API route not found',
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use(errorHandler);

export default app;
