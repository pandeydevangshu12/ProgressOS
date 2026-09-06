import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import app from '../backend/src/app.js';
import http from 'node:http';

describe('API Route & Authentication Enforcement', () => {
  let server: http.Server;
  let baseUrl: string;

  test('Start test server', async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://localhost:${port}`;
  });

  test('Unauthorized access to protected routes returns 401 in production mode', async () => {
    // In production without auth token, requireAuth throws AppError.unauthorized
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await fetch(`${baseUrl}/api/activities`);
      assert.equal(res.status, 401);
      const data = await res.json() as any;
      assert.equal(data.success, false);
      assert.ok(data.error.toLowerCase().includes('auth'));
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });

  test('Non-existent API route returns 404 JSON', async () => {
    const res = await fetch(`${baseUrl}/api/some-non-existent-endpoint`);
    assert.equal(res.status, 404);
    const data = await res.json() as any;
    assert.equal(data.success, false);
    assert.equal(data.error, 'API route not found');
  });

  test('CORS headers are present', async () => {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://example.com' },
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('access-control-allow-origin'));
  });

  test('Stop test server', () => {
    server.close();
  });
});
