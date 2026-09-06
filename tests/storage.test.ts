import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diskStorage, cloudinaryStorage, getStorageService, storageService } from '../backend/src/services/storage/storage.service.js';
import { isValidImageMagicBytes } from '../backend/src/middleware/upload.js';

describe('Storage & Upload Validation', () => {
  test('diskStorage save, get, and delete cycle', async () => {
    const testContent = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    const saved = await diskStorage.save('avatar.jpg', testContent, 'image/jpeg');

    assert.ok(saved.storageKey);
    assert.ok(saved.originalUrl.includes(saved.storageKey));

    // Get
    const fetched = await diskStorage.get(saved.storageKey);
    assert.ok(fetched);
    assert.equal(fetched.mimeType, 'image/jpeg');
    assert.ok(Buffer.isBuffer(fetched.data));
    assert.equal(fetched.data.length, testContent.length);

    // Delete
    await diskStorage.delete(saved.storageKey);
    const afterDelete = await diskStorage.get(saved.storageKey);
    assert.equal(afterDelete, null);
  });

  test('Path traversal is mitigated during retrieval', async () => {
    const result = await storageService.get('../../../etc/passwd');
    assert.equal(result, null);
  });

  test('Magic bytes validation accepts valid image headers', () => {
    // Valid JPEG (FF D8 FF)
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    assert.equal(isValidImageMagicBytes(jpeg), true);

    // Valid PNG (89 50 4E 47 ...)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.equal(isValidImageMagicBytes(png), true);

    // Valid WebP (RIFF....WEBP)
    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x20, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
    assert.equal(isValidImageMagicBytes(webp), true);
  });

  test('Magic bytes validation rejects malicious/non-image files', () => {
    // Plain text / bash script
    const text = Buffer.from('#!/bin/bash\necho hack');
    assert.equal(isValidImageMagicBytes(text), false);

    // Fake extension masquerading as jpeg
    const fake = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
    assert.equal(isValidImageMagicBytes(fake), false);
  });

  test('StorageService factory defaults to disk and switches to cloudinary when credentials present', () => {
    const prevCloud = process.env.CLOUDINARY_CLOUD_NAME;
    const prevKey = process.env.CLOUDINARY_API_KEY;
    const prevSecret = process.env.CLOUDINARY_API_SECRET;

    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    const defaultAdapter = getStorageService();
    assert.equal(defaultAdapter, diskStorage);

    process.env.CLOUDINARY_CLOUD_NAME = 'test_cloud';
    process.env.CLOUDINARY_API_KEY = 'test_key';
    process.env.CLOUDINARY_API_SECRET = 'test_secret';

    const cloudAdapter = getStorageService();
    assert.equal(cloudAdapter, cloudinaryStorage);

    if (prevCloud) process.env.CLOUDINARY_CLOUD_NAME = prevCloud; else delete process.env.CLOUDINARY_CLOUD_NAME;
    if (prevKey) process.env.CLOUDINARY_API_KEY = prevKey; else delete process.env.CLOUDINARY_API_KEY;
    if (prevSecret) process.env.CLOUDINARY_API_SECRET = prevSecret; else delete process.env.CLOUDINARY_API_SECRET;
  });
});
