import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { v2 as cloudinary } from 'cloudinary';
import { getWorkerEnv } from '../../config/workerEnv.js';

export interface SavedFile {
  storageKey: string;
  originalUrl: string;
  thumbnailUrl: string | null;
}

export interface FileDataResult {
  data: Buffer;
  mimeType: string;
  size?: number;
}

export interface StorageService {
  save(filename: string, buffer: Buffer, mimeType: string): Promise<SavedFile>;
  get(storageKeyOrUrl: string): Promise<FileDataResult | null>;
  delete(storageKey: string): Promise<void>;
}

function generateStorageKey(originalFilename: string): string {
  const ext = path.extname(originalFilename) || '.jpg';
  const sanitizedExt =
    ext.replace(/[^a-zA-Z0-9.]/g, '').toLowerCase() || '.jpg';

  return `${crypto.randomUUID()}${sanitizedExt}`;
}

function getMimeTypeFromKey(key: string): string {
  const ext = path.extname(key).toLowerCase();

  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.jpg':
    case '.jpeg':
    default:
      return 'image/jpeg';
  }
}

/**
 * Resolve the local uploads directory only when disk storage is actually used.
 * This prevents Worker startup from evaluating import.meta.url/fileURLToPath.
 */
function getUploadsDir(): string {
  return path.resolve(process.cwd(), 'uploads', 'photos');
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Directory may already exist.
  }
}

/**
 * Get the environment currently supplied by Cloudflare.
 */
function getCloudinaryCredentials() {
  const workerEnv = getWorkerEnv();

  return {
    cloudName:
      workerEnv?.CLOUDINARY_CLOUD_NAME ??
      process.env.CLOUDINARY_CLOUD_NAME,

    apiKey:
      workerEnv?.CLOUDINARY_API_KEY ??
      process.env.CLOUDINARY_API_KEY,

    apiSecret:
      workerEnv?.CLOUDINARY_API_SECRET ??
      process.env.CLOUDINARY_API_SECRET,
  };
}

/**
 * Local disk storage.
 * Used during local development only.
 */
export const diskStorage: StorageService = {
  async save(
    filename: string,
    buffer: Buffer,
    _mimeType: string
  ): Promise<SavedFile> {
    const uploadsDir = getUploadsDir();

    await ensureDir(uploadsDir);

    const storageKey = generateStorageKey(filename);
    const filePath = path.join(uploadsDir, storageKey);

    await fs.writeFile(filePath, buffer);

    return {
      storageKey,
      originalUrl: `/uploads/photos/${storageKey}`,
      thumbnailUrl: null,
    };
  },

  async get(storageKey: string): Promise<FileDataResult | null> {
    const sanitizedKey = path.basename(storageKey);
    const filePath = path.join(getUploadsDir(), sanitizedKey);

    try {
      const buffer = await fs.readFile(filePath);

      return {
        data: buffer,
        mimeType: getMimeTypeFromKey(sanitizedKey),
        size: buffer.length,
      };
    } catch {
      return null;
    }
  },

  async delete(storageKey: string): Promise<void> {
    const sanitizedKey = path.basename(storageKey);
    const filePath = path.join(getUploadsDir(), sanitizedKey);

    try {
      await fs.unlink(filePath);
    } catch {
      // Already removed / missing.
    }
  },
};

/**
 * Cloudinary persistent production storage.
 */
export const cloudinaryStorage: StorageService = {
  async save(
    _filename: string,
    buffer: Buffer,
    mimeType: string
  ): Promise<SavedFile> {
    const { cloudName, apiKey, apiSecret } = getCloudinaryCredentials();

    if (!cloudName || !apiKey || !apiSecret) {
      throw new Error(
        'Cloudinary credentials are required in production'
      );
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    });

    const base64Data =
      `data:${mimeType};base64,${buffer.toString('base64')}`;

    const uploadResult = await cloudinary.uploader.upload(base64Data, {
      folder: 'progressos/photos',
      resource_type: 'image',
    });

    return {
      storageKey: uploadResult.public_id,
      originalUrl: uploadResult.secure_url,
      thumbnailUrl: uploadResult.secure_url,
    };
  },

  async get(storageKeyOrUrl: string): Promise<FileDataResult | null> {
    try {
      let downloadUrl = storageKeyOrUrl;

      if (
        !downloadUrl.startsWith('http://') &&
        !downloadUrl.startsWith('https://')
      ) {
        const { cloudName, apiKey, apiSecret } =
          getCloudinaryCredentials();

        if (!cloudName) {
          return null;
        }

        cloudinary.config({
          cloud_name: cloudName,
          api_key: apiKey,
          api_secret: apiSecret,
          secure: true,
        });

        downloadUrl = cloudinary.url(storageKeyOrUrl, {
          secure: true,
        });
      }

      const response = await fetch(downloadUrl);

      if (!response.ok) {
        return diskStorage.get(storageKeyOrUrl);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      return {
        data: buffer,
        mimeType:
          response.headers.get('content-type') || 'image/jpeg',
        size: buffer.length,
      };
    } catch {
      return diskStorage.get(storageKeyOrUrl);
    }
  },

  async delete(storageKey: string): Promise<void> {
    try {
      const { cloudName, apiKey, apiSecret } =
        getCloudinaryCredentials();

      if (!cloudName) {
        return;
      }

      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });

      await cloudinary.uploader.destroy(storageKey);
    } catch {
      // Ignore missing files / deletion failures.
    }
  },
};

export function getStorageService(): StorageService {
  const { cloudName, apiKey, apiSecret } =
    getCloudinaryCredentials();

  if (cloudName && apiKey && apiSecret) {
    return cloudinaryStorage;
  }

  return diskStorage;
}

export const storageService: StorageService = new Proxy(
  {} as StorageService,
  {
    get(_target, prop) {
      const active = getStorageService();
      const value = Reflect.get(active, prop);

      if (typeof value === 'function') {
        return value.bind(active);
      }

      return value;
    },
  }
);