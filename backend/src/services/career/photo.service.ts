import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { storageService, StorageService } from '../storage/storage.service.js';
import { isValidImageMagicBytes } from '../../middleware/upload.js';

export class CareerPhotoService {
  private storage: StorageService;

  constructor(storage: StorageService = storageService) {
    this.storage = storage;
  }

  async getPhotos(userId: string) {
    const profile = await prisma.careerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) return [];

    return prisma.careerPhoto.findMany({
      where: { careerProfileId: profile.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upload(userId: string, file: Express.Multer.File) {
    let profile = await prisma.careerProfile.findUnique({ where: { userId } });
    if (!profile) {
      profile = await prisma.careerProfile.create({ data: { userId } });
    }

    if (!isValidImageMagicBytes(file.buffer)) {
      throw AppError.badRequest('Invalid image file: content does not match a valid JPEG, PNG, or WebP image');
    }

    const saved = await this.storage.save(
      file.originalname,
      file.buffer,
      file.mimetype
    );

    const existingCount = await prisma.careerPhoto.count({
      where: { careerProfileId: profile.id },
    });

    const photo = await prisma.careerPhoto.create({
      data: {
        careerProfileId: profile.id,
        storageKey: saved.storageKey,
        originalUrl: saved.originalUrl,
        thumbnailUrl: saved.thumbnailUrl,
        mimeType: file.mimetype,
        fileSize: file.size,
        fileName: file.originalname,
        isDefault: existingCount === 0,
      },
    });

    if (existingCount === 0) {
      await prisma.careerProfile.update({
        where: { id: profile.id },
        data: { defaultPhotoId: photo.id },
      });
    }

    return photo;
  }

  async delete(userId: string, photoId: string) {
    const profile = await prisma.careerProfile.findUnique({
      where: { userId },
      select: { id: true, defaultPhotoId: true },
    });
    if (!profile) throw AppError.notFound('Career profile not found');

    const photo = await prisma.careerPhoto.findFirst({
      where: { id: photoId, careerProfileId: profile.id },
    });
    if (!photo) throw AppError.notFound('Photo not found');

    await this.storage.delete(photo.storageKey);
    await prisma.careerPhoto.delete({ where: { id: photoId } });

    if (profile.defaultPhotoId === photoId) {
      const nextPhoto = await prisma.careerPhoto.findFirst({
        where: { careerProfileId: profile.id },
        orderBy: { createdAt: 'desc' },
      });
      await prisma.careerProfile.update({
        where: { id: profile.id },
        data: { defaultPhotoId: nextPhoto?.id ?? null },
      });
    }
  }

  async setDefault(userId: string, photoId: string) {
    const profile = await prisma.careerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) throw AppError.notFound('Career profile not found');

    const photo = await prisma.careerPhoto.findFirst({
      where: { id: photoId, careerProfileId: profile.id },
    });
    if (!photo) throw AppError.notFound('Photo not found');

    await prisma.careerPhoto.updateMany({
      where: { careerProfileId: profile.id },
      data: { isDefault: false },
    });

    await prisma.careerPhoto.update({
      where: { id: photoId },
      data: { isDefault: true },
    });

    await prisma.careerProfile.update({
      where: { id: profile.id },
      data: { defaultPhotoId: photoId },
    });

    return prisma.careerPhoto.findUnique({ where: { id: photoId } });
  }
}

export const careerPhotoService = new CareerPhotoService();
