import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import {
  VITProfileResponse,
  VITAnalyticsResponse,
  VITStatusResponse,
  CacheEntry,
} from './vit.types.js';

const UNI_CC_BASE = 'https://api.uni-cc.site/api';

const SEMESTER_CACHE_TTL = 24 * 60 * 60 * 1000;

interface VITSession {
  cookies: string;
  csrf: string;
  authorizedID: string;
}

function generateSemesterIds(): string[] {
  const now = new Date();
  const year = now.getFullYear();
  const ids: string[] = [];
  for (let y = year - 1; y <= year; y++) {
    const next = (y + 1).toString().slice(-2);
    ids.push(`CH${y}${next}01`);
    ids.push(`CH${y}${next}05`);
    ids.push(`CH${y}${next}07`);
  }
  return ids;
}

export class VitService {
  private cache = new Map<string, CacheEntry<any>>();
  private inFlight = new Map<string, Promise<any>>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private async getOrFetch<T>(cacheKey: string, fetchFn: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (this.inFlight.has(cacheKey)) {
      return this.inFlight.get(cacheKey)!;
    }

    const promise = (async () => {
      try {
        const data = await fetchFn();
        this.cache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  private async updateSyncTime(userId: string): Promise<void> {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { vitLastSync: new Date() },
      });
    } catch (err) {
      console.error('Failed to update VIT sync time:', err);
    }
  }

  async login(username: string, password: string): Promise<VITSession> {
    const response = await fetch(`${UNI_CC_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!response.ok) {
      const errBody: any = await response.json().catch(() => ({}));
      throw AppError.unauthorized(errBody?.message || 'VIT login failed — check your credentials');
    }

    const data: any = await response.json();

    if (!data.success) {
      throw AppError.unauthorized(data.message || 'VIT login failed');
    }

    if (!data.cookies || !data.csrf || !data.authorizedID) {
      throw AppError.internal('VIT API returned incomplete login data');
    }

    return {
      cookies: data.cookies,
      csrf: data.csrf,
      authorizedID: data.authorizedID,
    };
  }

  async getAcademicData(username: string, password: string, retries = 2, semesterId?: string, existingSession?: VITSession): Promise<any> {
    let session: VITSession;

    if (existingSession) {
      session = existingSession;
    } else {
      try {
        session = await this.login(username, password);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw AppError.unauthorized('VIT login failed — credentials may be incorrect');
      }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const body: any = {
          cookies: session.cookies,
          authorizedID: session.authorizedID,
          csrf: session.csrf,
        };
        if (semesterId) body.semesterId = semesterId;

        const response = await fetch(`${UNI_CC_BASE}/attendance`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          if (response.status === 401 && attempt < retries) {
            session = await this.login(username, password);
            continue;
          }
          const errBody: any = await response.json().catch(() => ({}));
          throw AppError.badRequest(errBody?.error || `VIT API returned HTTP ${response.status}`);
        }

        const raw = await response.json();
        return raw;
      } catch (error: any) {
        if (attempt < retries && (error instanceof AppError && error.statusCode === 401)) {
          session = await this.login(username, password);
          continue;
        }
        throw error;
      }
    }

    throw AppError.badRequest('Failed to fetch VIT academic data after retries');
  }

  async getProfile(userId: string): Promise<VITProfileResponse> {
    const cacheKey = `vit_profile_${userId}`;
    return this.getOrFetch(cacheKey, async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { vitUsername: true, vitPasswordEncrypted: true },
      });

      if (!user) throw AppError.notFound('User not found');
      if (!user.vitUsername || !user.vitPasswordEncrypted) {
        throw AppError.badRequest('VIT account not connected');
      }

      const password = decrypt(user.vitPasswordEncrypted);
      const data = await this.getAcademicData(user.vitUsername, password);

      const marksCgpa = data?.marksRes?.cgpa ?? {};
      const attRes = data?.attRes ?? {};

      const cgpaVal = parseFloat(String(marksCgpa.cgpa ?? 0)) || 0;
      const creditsEarned = parseFloat(String(marksCgpa.creditsEarned ?? 0)) || 0;
      const creditsRequired = parseFloat(String(marksCgpa.creditsRequired ?? 0)) || 0;

      const attendanceList: any[] = attRes.attendance ?? [];
      const attendedTotal = attendanceList.reduce((sum: number, a: any) => sum + (a.attendedClasses || 0), 0);
      const conductedTotal = attendanceList.reduce((sum: number, a: any) => sum + (a.totalClasses || 0), 0);
      const attendancePct = conductedTotal > 0
        ? parseFloat(((attendedTotal / conductedTotal) * 100).toFixed(2))
        : 0;

      await this.storeSnapshot(userId, cgpaVal, creditsEarned, creditsRequired, attendancePct);
      await this.updateSyncTime(userId);

      return {
        cgpa: cgpaVal,
        creditsEarned,
        creditsRequired,
        attendance: attendancePct,
      };
    });
  }

  async getCourses(userId: string): Promise<any[]> {
    const cacheKey = `vit_courses_${userId}`;
    return this.getOrFetch(cacheKey, async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { vitUsername: true, vitPasswordEncrypted: true },
      });

      if (!user) throw AppError.notFound('User not found');
      if (!user.vitUsername || !user.vitPasswordEncrypted) {
        throw AppError.badRequest('VIT account not connected');
      }

      const password = decrypt(user.vitPasswordEncrypted);
      const session = await this.login(user.vitUsername!, password);

      const tryFetch = async (semesterId?: string): Promise<any[]> => {
        try {
          const data = await this.getAcademicData(user.vitUsername!, password, 1, semesterId, session);
          const attRes = data?.attRes ?? {};
          return (attRes.attendance ?? []) as any[];
        } catch {
          return [];
        }
      };

      const seen = new Set<string>();
      const allCourses: any[] = [];

      const semesterIds = generateSemesterIds();
      for (const semId of semesterIds) {
        const courses = await tryFetch(semId);
        for (const c of courses) {
          const key = c.courseCode || c.courseTitle || Math.random().toString();
          if (!seen.has(key)) {
            seen.add(key);
            allCourses.push(c);
          }
        }
      }

      return allCourses.map((c: any) => ({
        courseCode: c.courseCode || '',
        courseTitle: c.courseTitle || '',
        slotName: c.slotName || '',
        faculty: c.faculty || null,
        attendedClasses: c.attendedClasses || 0,
        totalClasses: c.totalClasses || 0,
        attendancePercentage: c.attendancePercentage || '0',
        credits: c.credits || null,
        courseType: c.courseType || null,
        category: c.category || null,
      }));
    });
  }

  async getCombinedStats(userId: string): Promise<VITProfileResponse> {
    return this.getProfile(userId);
  }

  async getAnalytics(userId: string): Promise<VITAnalyticsResponse> {
    const cacheKey = `vit_analytics_${userId}`;
    return this.getOrFetch(cacheKey, async () => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { vitUsername: true, vitPasswordEncrypted: true },
      });

      if (!user || !user.vitUsername || !user.vitPasswordEncrypted) {
        return {
          cgpa: 0,
          creditsProgress: 0,
          attendance: 0,
          academicReadiness: 0,
        };
      }

      const profile = await this.getProfile(userId);
      const creditsProgress = profile.creditsRequired > 0
        ? parseFloat(((profile.creditsEarned / profile.creditsRequired) * 100).toFixed(1))
        : 0;
      const academicReadiness = this.calculateAcademicReadiness(
        profile.cgpa,
        profile.attendance,
        creditsProgress,
      );
      return {
        cgpa: profile.cgpa,
        creditsProgress,
        attendance: profile.attendance,
        academicReadiness,
      };
    });
  }

  calculateAcademicReadiness(cgpa: number, attendance: number, creditsProgress: number): number {
    const cgpaScore = Math.min(50, (cgpa / 10) * 50);
    const attendanceScore = Math.min(25, (attendance / 100) * 25);
    const creditsScore = Math.min(25, (creditsProgress / 100) * 25);
    return Math.round(cgpaScore + attendanceScore + creditsScore);
  }

  async getStatus(userId: string): Promise<VITStatusResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { vitUsername: true, vitLastSync: true },
    });
    if (!user) throw AppError.notFound('User not found');
    return {
      connected: !!user.vitUsername,
      vitUsername: user.vitUsername,
      vitLastSync: user.vitLastSync ? user.vitLastSync.toISOString() : null,
    };
  }

  async connect(userId: string, username: string, password: string): Promise<VITStatusResponse> {
    await this.login(username, password);
    const encryptedPassword = encrypt(password);
    this.invalidateCache(userId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        vitUsername: username,
        vitPasswordEncrypted: encryptedPassword,
      },
    });
    await this.getAcademicData(username, password);
    await this.updateSyncTime(userId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { vitLastSync: true },
    });
    return {
      connected: true,
      vitUsername: username,
      vitLastSync: user?.vitLastSync ? user.vitLastSync.toISOString() : null,
    };
  }

  async disconnect(userId: string): Promise<void> {
    this.invalidateCache(userId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        vitUsername: null,
        vitPasswordEncrypted: null,
        vitLastSync: null,
      },
    });
  }

  private invalidateCache(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.includes(userId)) {
        this.cache.delete(key);
      }
    }
  }

  private async storeSnapshot(
    userId: string,
    cgpa: number,
    creditsEarned: number,
    creditsRequired: number,
    attendance: number,
  ): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const existing = await prisma.vITSnapshot.findFirst({
        where: { userId, createdAt: { gte: today, lt: tomorrow } },
      });
      if (!existing) {
        await prisma.vITSnapshot.create({
          data: { userId, cgpa, creditsEarned, creditsRequired, attendance },
        });
      }
    } catch (err) {
      console.error('Failed to store VIT snapshot:', err);
    }
  }
}

export const vitService = new VitService();
