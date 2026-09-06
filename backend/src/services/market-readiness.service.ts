import { prisma } from '../config/database.js';
import { leetCodeService } from '../integrations/leetcode/leetcode.service.js';
import { gitHubService } from '../integrations/github/github.service.js';
import { codeforcesService } from '../integrations/codeforces/codeforces.service.js';
import { AppError } from '../utils/AppError.js';

interface ComponentScore {
  label: string;
  score: number;
  weight: number;
  color: string;
}

interface Recommendation {
  action: string;
  impact: string;
  priority: 'high' | 'medium' | 'low';
}

export interface MarketReadinessResponse {
  overall: number;
  label: string;
  components: ComponentScore[];
  reasons: string[];
  recommendations: Recommendation[];
}

function getLabel(score: number): string {
  if (score >= 90) return 'Top Performer';
  if (score >= 75) return 'Strong';
  if (score >= 60) return 'Progressing';
  if (score >= 40) return 'Developing';
  return 'Getting Started';
}

function xpToScore(xp: number, divisor: number = 50): number {
  return Math.min(100, Math.round(xp / divisor));
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class MarketReadinessService {
  private cache = new Map<string, CacheEntry<MarketReadinessResponse>>();
  private inFlight = new Map<string, Promise<MarketReadinessResponse>>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  async compute(userId: string): Promise<MarketReadinessResponse> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (this.inFlight.has(userId)) {
      return this.inFlight.get(userId)!;
    }

    const promise = (async () => {
      try {
        const result = await this.computeInternal(userId);
        this.cache.set(userId, { data: result, timestamp: Date.now() });
        return result;
      } finally {
        this.inFlight.delete(userId);
      }
    })();

    this.inFlight.set(userId, promise);
    return promise;
  }

  private async computeInternal(userId: string): Promise<MarketReadinessResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        totalXP: true,
        githubUsername: true,
        codeforcesHandle: true,
        leetcodeUsername: true,
      },
    });
    if (!user) throw AppError.notFound('User not found');

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentActivities = await prisma.activity.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
    });

    const catXP: Record<string, number> = { DSA: 0, PROJECT: 0, ACADEMICS: 0, OPEN_SOURCE: 0 };
    recentActivities.forEach(a => {
      if (catXP[a.category] !== undefined) catXP[a.category] += a.xp;
    });

    // ── DSA Score (weight 30%) ────────────────────────────────────
    let dsaScore = xpToScore(catXP.DSA, 60);
    if (user.leetcodeUsername) {
      try {
        const lcReadiness = await leetCodeService.getReadiness(userId, user.leetcodeUsername);
        dsaScore = Math.max(dsaScore, lcReadiness.dsaReadiness);
      } catch {}
    }
    if (user.codeforcesHandle) {
      try {
        const cfAnalytics = await codeforcesService.getAnalytics(userId, user.codeforcesHandle);
        dsaScore = Math.max(dsaScore, cfAnalytics.dsaScore);
      } catch {}
    }

    // ── Projects Score (weight 25%) ───────────────────────────────
    let projectsScore = xpToScore(catXP.PROJECT, 80);
    if (user.githubUsername) {
      try {
        const ghAnalytics = await gitHubService.getAnalytics(userId, user.githubUsername);
        projectsScore = Math.max(projectsScore, ghAnalytics.projectReadiness);
      } catch {}
    }

    // ── Core CS Score (weight 20%) ────────────────────────────────
    let coreCSScore = xpToScore(catXP.ACADEMICS, 40);
    try {
      const subjectCount = await prisma.subjectEntry.count({ where: { userId } });
      if (subjectCount > 0) {
        coreCSScore = Math.max(coreCSScore, Math.min(100, Math.round((subjectCount / 12) * 100)));
      }
    } catch {}

    // ── Open Source Score (weight 15%) ────────────────────────────
    let ossScore = xpToScore(catXP.OPEN_SOURCE, 30);
    if (user.githubUsername) {
      try {
        const ghActivity = await gitHubService.getActivity(userId, user.githubUsername);
        const ossFromGh = Math.min(100,
          Math.round(ghActivity.totalStars * 5 + ghActivity.activeProjects * 10)
        );
        ossScore = Math.max(ossScore, ossFromGh);
      } catch {}
    }
    try {
      const prCount = await prisma.openSourceEntry.count({ where: { userId } });
      if (prCount > 0) {
        ossScore = Math.max(ossScore, Math.min(100, Math.round((prCount / 10) * 100)));
      }
    } catch {}

    // ── Research Score (weight 10%) ───────────────────────────────
    let researchScore = 10;
    try {
      const researchCount = await prisma.researchEntry.count({ where: { userId } });
      if (researchCount > 0) {
        researchScore = Math.min(100, Math.round((researchCount / 5) * 100));
      }
    } catch {}

    const components: ComponentScore[] = [
      { label: 'DSA', score: dsaScore, weight: 30, color: 'bg-primary' },
      { label: 'Projects', score: projectsScore, weight: 25, color: 'bg-secondary' },
      { label: 'Core CS', score: coreCSScore, weight: 20, color: 'bg-blue-500' },
      { label: 'Open Source', score: ossScore, weight: 15, color: 'bg-purple-500' },
      { label: 'Research', score: researchScore, weight: 10, color: 'bg-teal-500' },
    ];

    const overall = Math.round(
      components.reduce((sum, c) => sum + c.score * c.weight, 0) / 100
    );

    // ── Reasons ───────────────────────────────────────────────────
    const reasons: string[] = [];
    const sorted = [...components].sort((a, b) => a.score - b.score);
    const weakest = sorted[0];
    const strongest = sorted[sorted.length - 1];

    reasons.push(`${strongest.label} is your strongest area at ${strongest.score}/100.`);
    if (weakest.score < 40) {
      reasons.push(`${weakest.label} needs significant improvement (${weakest.score}/100).`);
    } else if (weakest.score < 60) {
      reasons.push(`${weakest.label} is lagging behind at ${weakest.score}/100.`);
    } else {
      reasons.push(`${weakest.label} has room to grow (${weakest.score}/100).`);
    }

    const belowAverage = components.filter(c => c.score < 50);
    if (belowAverage.length > 1) {
      reasons.push(`${belowAverage.length} areas are below 50 — focused effort will boost your score fastest.`);
    }

    // ── Recommendations ───────────────────────────────────────────
    const recommendations: Recommendation[] = [];

    if (dsaScore < 60) {
      recommendations.push({
        action: `Solve 20 more LeetCode problems to raise DSA (${dsaScore} → ${Math.min(100, dsaScore + 10)}).`,
        impact: `+${Math.round(10 * 0.3)} points to overall score`,
        priority: dsaScore < 40 ? 'high' : 'medium',
      });
    }
    if (projectsScore < 60) {
      recommendations.push({
        action: 'Push code daily to an active GitHub repo for 2 weeks.',
        impact: `+${Math.round(10 * 0.25)} points to overall score`,
        priority: projectsScore < 40 ? 'high' : 'medium',
      });
    }
    if (coreCSScore < 50) {
      recommendations.push({
        action: 'Complete Core CS topics — DBMS, OS, Networks, OOP.',
        impact: `+${Math.round(15 * 0.2)} points to overall score`,
        priority: 'medium',
      });
    }
    if (ossScore < 40) {
      recommendations.push({
        action: 'Submit 1 Open Source PR this week.',
        impact: `+${Math.round(20 * 0.15)} points to overall score`,
        priority: 'high',
      });
    }
    if (researchScore < 30) {
      recommendations.push({
        action: 'Write a research paper or start a literature survey.',
        impact: `+${Math.round(25 * 0.1)} points to overall score`,
        priority: 'low',
      });
    }

    if (recommendations.length === 0) {
      recommendations.push({
        action: 'Keep up the great work across all areas!',
        impact: 'Maintain your current pace for continued growth.',
        priority: 'medium',
      });
    }

    return {
      overall,
      label: getLabel(overall),
      components,
      reasons,
      recommendations: recommendations.slice(0, 3),
    };
  }
}

export const marketReadinessService = new MarketReadinessService();
