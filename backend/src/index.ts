import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import app from './app.js';
import { env } from './config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../');

// In local development / standalone Node server, serve static frontend files
if (env.NODE_ENV !== 'production' || !process.env.CLOUDFLARE_WORKER) {
  app.use(
    express.static(rootDir, {
      maxAge: '1h',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    })
  );

  // Main application dashboard at / and /app
  app.get(['/', '/app'], (_req, res) => {
    res.sendFile(path.join(rootDir, 'index.html'));
  });

  // Public profile route — serves the SPA page, JS reads username from URL
  app.get('/u/:username', (_req, res) => {
    res.sendFile(path.join(rootDir, 'u.html'));
  });

  // Career Studio dashboard
  app.get('/career-studio', (_req, res) => {
    res.sendFile(path.join(rootDir, 'career-studio/index.html'));
  });

  // Serve uploaded files directly from disk in local development
  app.use('/uploads', express.static(path.join(rootDir, 'uploads')));
}

// 404 Catch-All
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found',
  });
});

// Standalone server listen (local development)
if (!process.env.VERCEL && !process.env.CLOUDFLARE_WORKER) {
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
