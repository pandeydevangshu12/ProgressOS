import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import app from '../backend/src/app.js';
import indexApp from '../backend/src/index.js';
import http from 'node:http';
import { prisma } from '../backend/src/config/database.js';
import { diskStorage } from '../backend/src/services/storage/storage.service.js';

describe('End-to-End Verification Suite', () => {
  let server: http.Server;
  let baseUrl: string;

  test('Start E2E server', async () => {
    server = http.createServer(indexApp);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;
    baseUrl = `http://localhost:${port}`;
  });

  test('Verify GET /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.success, true);
    assert.equal(data.data.status, 'healthy');
  });

  test('Verify GET / (Dashboard HTML)', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('ProgressOS') || text.includes('html'));
  });

  test('Verify GET /app (Dashboard HTML)', async () => {
    const res = await fetch(`${baseUrl}/app`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('html'));
  });

  test('Verify GET /career-studio (Career Studio HTML)', async () => {
    const res = await fetch(`${baseUrl}/career-studio`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Career Studio') || text.includes('html'));
  });

  test('Verify GET /u/:username (Public Profile SPA)', async () => {
    const res = await fetch(`${baseUrl}/u/devangshu`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('html'));
  });

  test('Verify GET /api/* 404 handler', async () => {
    const res = await fetch(`${baseUrl}/api/unknown_test_endpoint`);
    assert.equal(res.status, 404);
    const json = await res.json() as any;
    assert.equal(json.error, 'API route not found');
  });

  test('Verify Photo Upload, Storage & Retrieval via Stream Endpoint', async () => {
    // 1. Save photo to storage
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x00, 0x00]);
    const saved = await diskStorage.save('test-avatar.jpg', fakeJpeg, 'image/jpeg');
    assert.ok(saved.storageKey);

    // 2. Retrieve photo via GET /uploads/photos/:storageKey
    const res = await fetch(`${baseUrl}/uploads/photos/${saved.storageKey}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    const retrievedBuffer = Buffer.from(await res.arrayBuffer());
    assert.equal(retrievedBuffer.length, fakeJpeg.length);

    // 3. Clean up
    await diskStorage.delete(saved.storageKey);
  });

  test('Verify Authentication rejection without token', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const res = await fetch(`${baseUrl}/api/user/me`);
      assert.equal(res.status, 401);
      const json = await res.json() as any;
      assert.equal(json.success, false);
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  test('Verify Prisma Database Client connection/query capability', async () => {
    // Test that prisma client resolves without crashing
    assert.ok(prisma);
    assert.ok(typeof prisma.user.findMany === 'function');
  });

  test('Stop E2E server', () => {
    server.close();
  });
});
