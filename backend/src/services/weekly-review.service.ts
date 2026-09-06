import { prisma } from '../config/database.js';
import { leetCodeService } from '../integrations/leetcode/leetcode.service.js';
import { gitHubService } from '../integrations/github/github.service.js';
import { codeforcesService } from '../integrations/codeforces/codeforces.service.js';
import { AppError } from '../utils/AppError.js';

interface DayActivity {
  date: string;
  label: string;
  xp: number;
  hours: number;
  tasks: number;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface WeeklyReviewResponse {
  weekStart: string;
  weekEnd: string;
  xpEarned: number;
  hoursLogged: number;
  tasksCompleted: number;
  peakDay: string;
  problemsSolved: number | null;
  commits: number | null;
  projectsWorkedOn: number | null;
  strongestArea: string;
  weakestArea: string;
  dailyBreakdown: DayActivity[];
  insight: string;
  comparison: {
    previousWeekXP: number;
    change: number;
  } | null;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class WeeklyReviewService {
  private cache = new Map<string, CacheEntry<WeeklyReviewResponse>>();
  private inFlight = new Map<string, Promise<WeeklyReviewResponse>>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  async generate(userId: string): Promise<WeeklyReviewResponse> {
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

  private async generateInternal(userId: string): Promise<WeeklyReviewResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { leetcodeUsername: true, githubUsername: true, codeforcesHandle: true },
    });
    if (!user) throw AppError.notFound('User not found');

    const now = new Date();
    const dayOfWeek = now.getDay();
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - mondayOffset);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 7);

    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);

    const activities = await prisma.activity.findMany({
      where: { userId, createdAt: { gte: weekStart, lt: weekEnd } },
      orderBy: { createdAt: 'asc' },
    });

    const prevActivities = await prisma.activity.findMany({
      where: { userId, createdAt: { gte: prevWeekStart, lt: weekStart } },
    });

    const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const dailyBreakdown: DayActivity[] = dayLabels.map((label, i) => {
      const dayStart = new Date(weekStart);
      dayStart.setDate(weekStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayStart.getDate() + 1);

      const dayActs = activities.filter(a => {
        const d = new Date(a.createdAt);
        return d >= dayStart && d < dayEnd;
      });

      const xp = dayActs.reduce((s, a) => s + a.xp, 0);
      const hours = dayActs.reduce((s, a) => s + a.hours, 0);
      const tasks = dayActs.length;

      let intensity: 0 | 1 | 2 | 3 | 4 = 0;
      if (xp > 0) intensity = xp > 200 ? 4 : xp > 100 ? 3 : xp > 50 ? 2 : 1;

      return {
        date: dayStart.toISOString().split('T')[0],
        label,
        xp: Math.round(xp),
        hours: Math.round(hours * 10) / 10,
        tasks,
        intensity,
      };
    });

    const totalXP = Math.round(dailyBreakdown.reduce((s, d) => s + d.xp, 0));
    const totalHours = Math.round(dailyBreakdown.reduce((s, d) => s + d.hours, 0) * 10) / 10;
    const totalTasks = dailyBreakdown.reduce((s, d) => s + d.tasks, 0);

    const peak = [...dailyBreakdown].sort((a, b) => b.xp - a.xp)[0];

    const prevXP = Math.round(prevActivities.reduce((s, a) => s + a.xp, 0));
    const change = prevXP > 0 ? Math.round(((totalXP - prevXP) / prevXP) * 100) : 0;

    // ── Problems solved (LeetCode) ──────────────────────────
    let problemsSolved: number | null = null;
    if (user.leetcodeUsername) {
      try {
        const profile = await leetCodeService.getProfile(userId, user.leetcodeUsername);
        problemsSolved = profile.totalSolved;
      } catch {}
    }

    // ── Commits & projects (GitHub) ─────────────────────────
    let commits: number | null = null;
    let projectsWorkedOn: number | null = null;
    if (user.githubUsername) {
      try {
        const activity = await gitHubService.getActivity(userId, user.githubUsername);
        commits = activity.commitsLast30Days;
        projectsWorkedOn = activity.activeProjects;
      } catch {}
    }

    // ── Strongest / weakest area ────────────────────────────
    const catXP: Record<string, number> = {};
    activities.forEach(a => { catXP[a.category] = (catXP[a.category] || 0) + a.xp; });
    const sorted = Object.entries(catXP).sort((a, b) => b[1] - a[1]);
    const strongestArea = sorted.length > 0 ? sorted[0][0] : 'N/A';
    const weakestArea = sorted.length > 0 ? sorted[sorted.length - 1][0] : 'N/A';

    // ── Weekly insight ──────────────────────────────────────
    let insight = 'Not enough data to generate an insight for this week.';
    if (totalXP > 0) {
      const strongLabel = strongestArea;
      if (change > 20) {
        insight = `Strong week! ${strongLabel} led at ${Math.round((catXP[strongestArea] / totalXP) * 100)}% of XP.`;
      } else if (change < -20) {
        insight = `Recovery week — ${totalXP} XP is ${Math.abs(change)}% below your previous week.`;
      } else {
        insight = `Consistent week across ${Object.keys(catXP).length} categories. Keep building!`;
      }
    }

    return {
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      xpEarned: totalXP,
      hoursLogged: totalHours,
      tasksCompleted: totalTasks,
      peakDay: peak.label,
      problemsSolved,
      commits,
      projectsWorkedOn,
      strongestArea,
      weakestArea,
      dailyBreakdown,
      insight,
      comparison: prevActivities.length > 0 ? { previousWeekXP: prevXP, change } : null,
    };
  }
}

export const weeklyReviewService = new WeeklyReviewService();
