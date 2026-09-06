import path from 'node:path';
import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
export const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

// In-memory buffering so StorageService abstraction can process the file
const storage = multer.memoryStorage();

function fileFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  // 1. Validate MIME header
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(new Error('Only JPEG, PNG, and WebP images are allowed'));
    return;
  }

  // 2. Validate file extension
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    cb(new Error('Invalid file extension. Allowed extensions: .jpg, .jpeg, .png, .webp'));
    return;
  }

  cb(null, true);
}

/**
 * Validates genuine image binary magic bytes to prevent extension/MIME spoofing.
 */
export function isValidImageMagicBytes(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) {
    return false;
  }

  // JPEG: Starts with FF D8 FF
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (isJpeg) return true;

  // PNG: Starts with 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
  if (isPng) return true;

  // WebP: Starts with RIFF .... WEBP
  const isRiff =
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46;
  const isWebp =
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;
  if (isRiff && isWebp) return true;

  return false;
}

export const uploadPhoto = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});
