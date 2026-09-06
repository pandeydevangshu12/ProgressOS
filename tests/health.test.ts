import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import app from '../backend/src/app.js';
import http from 'node:http';

describe('Health Checks', () => {
  test('GET /health returns 200 healthy status', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://localhost:${port}/health`);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.success, true);
      assert.equal(data.data.status, 'healthy');
    } finally {
      server.close();
    }
  });

  test('GET /api/health returns 200 healthy status', async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      assert.equal(res.status, 200);
      const data = await res.json() as any;
      assert.equal(data.success, true);
      assert.equal(data.data.status, 'healthy');
    } finally {
      server.close();
    }
  });
});
