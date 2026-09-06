import { httpServerHandler } from 'cloudflare:node';
import app from './app.js';
import { setWorkerEnv, WorkerEnv } from './config/workerEnv.js';

// Bind Express application to internal port 3000 for Cloudflare Workers Node HTTP integration
app.listen(3000);

const nodeHandler = httpServerHandler({ port: 3000 });

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: any): Promise<Response> {
    // 1. Initialize worker environment bindings (Hyperdrive, Secrets)
    setWorkerEnv(env);

    const url = new URL(request.url);

    // 2. Route API, uploads, and health check to Express application
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/uploads/') ||
      url.pathname === '/health'
    ) {
      try {
        const handlerFn = (nodeHandler as any).fetch || nodeHandler;
        return await handlerFn.call(nodeHandler, request, env, ctx);
      } catch (err: any) {
        console.error('💥 Worker unhandled API error:', err);
        return new Response(
          JSON.stringify({
            success: false,
            error: err?.message || 'Internal server error',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
    }

    // 3. Static assets & HTML Page Routing via Cloudflare Static Assets
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      const pathname = url.pathname;

      // Handle user profile route /u/:username -> /u.html
      if (pathname.startsWith('/u/')) {
        const uUrl = new URL('/u.html', request.url);
        const uRes = await env.ASSETS.fetch(new Request(uUrl.toString(), request));
        if (uRes.status !== 404) {
          return uRes;
        }
      }

      // Serve canonical static assets and routes (/, /app, /career-studio, /js/*, etc.)
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status !== 404) {
        return assetResponse;
      }

      // Fallback for /app to root index if needed
      if (pathname === '/app' || pathname === '/app/') {
        return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      }
    }

    // 4. Fallback to Express application
    try {
      const handlerFn = (nodeHandler as any).fetch || nodeHandler;
      return await handlerFn.call(nodeHandler, request, env, ctx);
    } catch (err: any) {
      console.error('💥 Worker unhandled fallback error:', err);
      return new Response(
        JSON.stringify({
          success: false,
          error: err?.message || 'Internal server error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
