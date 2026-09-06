import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

describe('Client Static Distribution Security', () => {
  const distClient = path.resolve(process.cwd(), 'dist/client');

  test('dist/client exists after build', () => {
    assert.ok(fs.existsSync(distClient), 'dist/client should exist');
  });

  test('Contains only designated public static assets', () => {
    assert.ok(fs.existsSync(path.join(distClient, 'index.html')));
    assert.ok(fs.existsSync(path.join(distClient, 'app')));
    assert.ok(fs.existsSync(path.join(distClient, 'u.html')));
    assert.ok(fs.existsSync(path.join(distClient, 'sw.js')));
    assert.ok(fs.existsSync(path.join(distClient, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(distClient, 'trackers')));
    assert.ok(fs.existsSync(path.join(distClient, 'career-studio')));
  });

  test('_redirects file is properly formed for Cloudflare', () => {
    const redirectsPath = path.join(distClient, '_redirects');
    assert.ok(fs.existsSync(redirectsPath));
    const content = fs.readFileSync(redirectsPath, 'utf-8');
    assert.ok(content.includes('/app'));
    assert.ok(content.includes('/u/*'));
    assert.ok(content.includes('/career-studio'));
  });

  test('CRITICAL SECURITY: Does NOT leak private repository files', () => {
    // Must NOT contain backend code
    assert.equal(fs.existsSync(path.join(distClient, 'backend')), false);
    // Must NOT contain node_modules
    assert.equal(fs.existsSync(path.join(distClient, 'node_modules')), false);
    // Must NOT contain workerd binary
    assert.equal(fs.existsSync(path.join(distClient, 'workerd')), false);
    // Must NOT contain source package.json or git
    assert.equal(fs.existsSync(path.join(distClient, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(distClient, '.env')), false);
    assert.equal(fs.existsSync(path.join(distClient, '.git')), false);
  });
});
