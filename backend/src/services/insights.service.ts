import { prisma } from '../config/database.js';
import { leetCodeService } from '../integrations/leetcode/leetcode.service.js';
import { codeforcesService } from '../integrations/codeforces/codeforces.service.js';
import { gitHubService } from '../integrations/github/github.service.js';
import { AppError } from '../utils/AppError.js';

interface Insight {
  type: 'milestone' | 'warning' | 'opportunity' | 'achievement' | 'trend';
  icon: string;
  message: string;
  detail?: string;
}

interface ROIAction {
  action: string;
  impact: string;
  effort: 'high' | 'medium' | 'low';
}

export interface InsightsResponse {
  insights: Insight[];
  roiActions: ROIAction[];
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class InsightsService {
  private cache = new Map<string, CacheEntry<InsightsResponse>>();
  private inFlight = new Map<string, Promise<InsightsResponse>>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  async generate(userId: string): Promise<InsightsResponse> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (this.inFlight.has(userId)) {
      return this.inFlight.get(userId)!;
    }

    const promise = (async () => {
      try {
        const result = await this.generateInternal(userId);
        this.cache.set(userId, { data: result, timestamp: Date.now() });
        return result;
      } finally {
        this.inFlight.delete(userId);
      }
    })();

    this.inFlight.set(userId, promise);
    return promise;
  }

  private async generateInternal(userId: string): Promise<InsightsResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        totalXP: true,
        currentStreak: true,
        longestStreak: true,
        githubUsername: true,
        codeforcesHandle: true,
        leetcodeUsername: true,
      },
    });
    if (!user) throw AppError.notFound('User not found');

    const insights: Insight[] = [];
    const roiActions: ROIAction[] = [];

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    const activities = await prisma.activity.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
    });

    const week1 = activities.filter(a => a.createdAt >= sevenDaysAgo);
    const week2 = activities.filter(
      a => a.createdAt >= sixtyDaysAgo && a.createdAt < thirtyDaysAgo
    );

    const weeklyXP = week1.reduce((s, a) => s + a.xp, 0);
    const prevWeeklyXP = week2.reduce((s, a) => s + a.xp, 0);

    // ── Streak ──────────────────────────────────────────────
    if (user.currentStreak >= 3) {
      const isPB = user.currentStreak >= (user.longestStreak || 0) && user.currentStreak > 0;
      insights.push({
        type: isPB ? 'achievement' : 'milestone',
        icon: isPB ? 'emoji_events' : 'local_fire_department',
        message: isPB
          ? `New personal best! You're on a ${user.currentStreak}-day streak`
          : `You're on a ${user.currentStreak}-day streak — keep it going!`,
        detail: `Longest streak: ${user.longestStreak} days`,
      });
    } else {
      const last = activities[0];
      if (last) {
        const daysSince = Math.floor(
          (now.getTime() - new Date(last.createdAt).getTime()) / (1000 * 60 * 60 * 24)
        );
        if (daysSince >= 3) {
          insights.push({
            type: 'warning',
            icon: 'error_outline',
            message: `No activity logged in ${daysSince} days.`,
            detail: 'Daily logging builds consistency and compounds XP growth.',
          });
        }
      } else {
        insights.push({
          type: 'opportunity',
          icon: 'rocket_launch',
          message: 'Start logging your first activity to unlock insights!',
        });
      }
    }

    // ── Weekly comparison ──────────────────────────────────
    if (week1.length > 0 && week2.length > 0) {
      const change = Math.round(((weeklyXP - prevWeeklyXP) / prevWeeklyXP) * 100);
      if (Math.abs(change) >= 10) {
        insights.push({
          type: change > 0 ? 'achievement' : 'warning',
          icon: change > 0 ? 'trending_up' : 'trending_down',
          message: change > 0
            ? `Activity up ${change}% vs last week`
            : `Activity down ${Math.abs(change)}% vs last week`,
          detail: `${weeklyXP} XP this week vs ${prevWeeklyXP} XP last week`,
        });
        if (change < 0) {
          roiActions.push({
            action: 'Add 30 min/day to recover your weekly XP pace.',
            impact: `Potential: ~${Math.round(prevWeeklyXP * 0.3)} XP/week`,
            effort: 'low',
          });
        }
      }
    }

    // ── LeetCode ────────────────────────────────────────────
    if (user.leetcodeUsername) {
      try {
        const profile = await leetCodeService.getProfile(userId, user.leetcodeUsername);
        const analytics = await leetCodeService.getAnalytics(userId, user.leetcodeUsername);
        const readiness = await leetCodeService.getReadiness(userId, user.leetcodeUsername);

        if (profile.hard === 0) {
          insights.push({
            type: 'opportunity',
            icon: 'psychology',
            message: 'No hard LeetCode problems solved yet.',
            detail: 'Hard problems carry the most weight in interviews and DSA readiness.',
          });
        }
        if (readiness.dsaReadiness >= 70) {
          insights.push({
            type: 'milestone',
            icon: 'stars',
            message: `DSA Readiness at ${readiness.dsaReadiness}/100 — interview-ready!`,
          });
        }
        if (analytics.weeklyAverage > 0) {
          const proj = Math.round(analytics.weeklyAverage * 4);
          insights.push({
            type: 'trend',
            icon: 'bar_chart',
            message: `Solving ${analytics.weeklyAverage} problems/week on average.`,
            detail: `At this pace: ~${proj} more problems this month (${profile.totalSolved + proj} total).`,
          });
        }
        if (profile.easy > profile.medium && profile.totalSolved > 10) {
          roiActions.push({
            action: 'Shift focus to Medium problems — they build stronger problem-solving skills.',
            impact: 'Mediums improve interview performance more per-problem than Easies.',
            effort: 'medium',
          });
        }
      } catch {}
    }

    // ── Codeforces ──────────────────────────────────────────
    if (user.codeforcesHandle) {
      try {
        const profile = await codeforcesService.getProfile(userId, user.codeforcesHandle);
        const analytics = await codeforcesService.getAnalytics(userId, user.codeforcesHandle);

        if (profile.rating > 0) {
          const rankOrder = ['newbie', 'pupil', 'specialist', 'expert', 'candidate master', 'master'];
          const idx = rankOrder.indexOf(profile.rank.toLowerCase());
          if (idx >= 0 && idx < rankOrder.length - 1) {
            insights.push({
              type: 'milestone',
              icon: 'flag',
              message: `Codeforces rating: ${profile.rating} (${profile.rank}).`,
              detail: `Next rank: ${rankOrder[idx + 1]} — keep competing!`,
            });
          }
        }
        if (analytics.solvedCount > 0) {
          const recent = analytics.recentActivity.length;
          if (recent < 5) {
            roiActions.push({
              action: 'Compete in the next Codeforces round to get back in rhythm.',
              impact: 'Each contest builds rating and DSA skills.',
              effort: 'medium',
            });
          }
        }
      } catch {}
    }

    // ── GitHub ──────────────────────────────────────────────
    if (user.githubUsername) {
      try {
        const activity = await gitHubService.getActivity(userId, user.githubUsername);

        if (activity.commitsLast30Days === 0) {
          insights.push({
            type: 'warning',
            icon: 'warning',
            message: 'No GitHub commits in the last 30 days.',
            detail: 'Regular commits demonstrate project engagement to employers.',
          });
        }
        if (activity.activeProjects >= 3) {
          insights.push({
            type: 'achievement',
            icon: 'diversity_3',
            message: `Active across ${activity.activeProjects} projects — great breadth!`,
          });
        }
        if (activity.commitsLast30Days > 50) {
          insights.push({
            type: 'achievement',
            icon: 'code',
            message: `${activity.commitsLast30Days} commits in 30 days — impressive output!`,
          });
        }
        if (activity.activeProjects === 0) {
          roiActions.push({
            action: 'Start a GitHub project or contribute to an existing one.',
            impact: 'Active projects add 10-15 points to your Projects score.',
            effort: 'medium',
          });
        }
      } catch {}
    }

    // ── Skill distribution ─────────────────────────────────
    if (activities.length >= 5) {
      const catXP: Record<string, number> = {};
      activities.forEach(a => { catXP[a.category] = (catXP[a.category] || 0) + a.xp; });
      const sorted = Object.entries(catXP).sort((a, b) => b[1] - a[1]);
      if (sorted.length >= 2) {
        const [topCat, topXP] = sorted[0];
        const [, secondXP] = sorted[1];
        const ratio = secondXP > 0 ? Math.round((topXP / secondXP) * 10) / 10 : 0;
        if (ratio > 3) {
          insights.push({
            type: 'trend',
            icon: 'donut_small',
            message: `${topCat} dominates at ${ratio}x the next category.`,
            detail: 'Diversifying across categories builds balanced market readiness.',
          });
        }
      }
    }

    // ── General ROI fallback ────────────────────────────────
    if (roiActions.length < 2) {
      const weakest = await this.findWeakestCategory(userId);
      if (weakest) {
        roiActions.push({
          action: `Dedicate 2 hours this week to ${weakest.label}.`,
          impact: `Strengthening your weakest area gives the highest ROI.`,
          effort: 'low',
        });
      }
    }

    return {
      insights: insights.slice(0, 5),
      roiActions: roiActions.slice(0, 3),
    };
  }

  private async findWeakestCategory(userId: string): Promise<{ label: string } | null> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const activities = await prisma.activity.findMany({
      where: { userId, createdAt: { gte: thirtyDaysAgo } },
    });

    const catXP: Record<string, number> = {};
    activities.forEach(a => { catXP[a.category] = (catXP[a.category] || 0) + a.xp; });

    const categories: Record<string, string> = {
      DSA: 'DSA (LeetCode / Codeforces)',
      PROJECT: 'Project Development',
      ACADEMICS: 'Core CS / Academics',
      OPEN_SOURCE: 'Open Source',
    };

    let weakest: string | null = null;
    let minXP = Infinity;
    for (const [cat, label] of Object.entries(categories)) {
      const xp = catXP[cat] || 0;
      if (xp < minXP) { minXP = xp; weakest = label; }
    }
    return weakest ? { label: weakest } : null;
  }
}

export const insightsService = new InsightsService();
