import express, { Router } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { clerkMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import userRoutes from './routes/user.routes.js';

const app = express();

// ─── Global Middleware ───────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false }));
app.use(
  cors({
    origin: env.NODE_ENV === 'production'
      ? process.env.FRONTEND_URL
      : '*',
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Clerk middleware — must be applied before any route that uses requireAuth
app.use(clerkMiddleware());

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

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── API Routes ──────────────────────────────────────────────────────────────


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

app.use('/api/career-studio', careerStudioRoutes);
app.use('/api/career-intelligence', careerIntelligenceRoutes);
app.use('/api/job-intelligence', jobIntelligenceRoutes);

// ─── Project Bullet Routes ────────────────────────────────────────────────

import { requireAuth } from './middleware/auth.js';
import { resumeCompositionController } from './controllers/career-studio/resume-composition.controller.js';
import { AuthenticatedRequest } from './types/index.js';

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

// Serve Frontend Static Files with caching
app.use(express.static(path.join(__dirname, '../../'), {
  maxAge: '1h',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Landing page at /
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../landing.html'));
});

// Dashboard at /app
app.get('/app', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../index.html'));
});

// Public profile route — serves the SPA page, JS reads username from URL
app.get('/u/:username', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../u.html'));
});

// Career Studio dashboard
app.get('/career-studio', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../career-studio/index.html'));
});

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../../uploads')));

// ─── 404 Catch-All ───────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

app.use(errorHandler);



// Only start listening when running as a standalone server (not in Vercel serverless)
if (!process.env.VERCEL) {
  app.listen(env.PORT, () => {
    console.log(`
    🚀 ProgressOS Backend is running!
    ────────────────────────────────────
    📡 Port:        ${env.PORT}
    🌍 Environment: ${env.NODE_ENV}
    🕐 Started at:  ${new Date().toISOString()}
    ────────────────────────────────────
    `);
  });
}

export default app;

// Trigger restart for prisma client

