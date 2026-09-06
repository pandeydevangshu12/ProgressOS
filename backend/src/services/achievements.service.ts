import { prisma } from '../config/database.js';
import { marketReadinessService } from './market-readiness.service.js';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  icon: string;
  category: 'milestone' | 'streak' | 'integration' | 'dsa' | 'project' | 'readiness';
  unlocked: boolean;
  unlockedAt?: string;
  progress?: { current: number; target: number };
}

const ACHIEVEMENT_DEFS: Omit<Achievement, 'unlocked' | 'unlockedAt' | 'progress'>[] = [
  { id: 'first_activity', title: 'First Steps', description: 'Log your first activity', icon: 'rocket_launch', category: 'milestone' },
  { id: 'streak_7', title: 'Week Warrior', description: 'Maintain a 7-day streak', icon: 'local_fire_department', category: 'streak' },
  { id: 'streak_30', title: 'Unstoppable', description: 'Maintain a 30-day streak', icon: 'whatshot', category: 'streak' },
  { id: 'xp_100', title: 'Century', description: 'Earn 100 total XP', icon: 'bar_chart', category: 'milestone' },
  { id: 'xp_1000', title: 'Power User', description: 'Earn 1,000 total XP', icon: 'bar_chart', category: 'milestone' },
  { id: 'xp_5000', title: 'Elite', description: 'Earn 5,000 total XP', icon: 'star', category: 'milestone' },
  { id: 'level_10', title: 'Double Digits', description: 'Reach Level 10', icon: 'verified', category: 'milestone' },
  { id: 'level_25', title: 'Veteran', description: 'Reach Level 25', icon: 'verified', category: 'milestone' },
  { id: 'leetcode_first', title: 'LeetCode Initiate', description: 'Connect your LeetCode account', icon: 'code', category: 'dsa' },
  { id: 'leetcode_100', title: 'Century of Code', description: 'Solve 100 LeetCode problems', icon: 'code', category: 'dsa' },
  { id: 'codeforces_first', title: 'Competitor', description: 'Connect your Codeforces account', icon: 'military_tech', category: 'dsa' },
  { id: 'codeforces_specialist', title: 'Specialist', description: 'Reach Codeforces Specialist (1400+)', icon: 'emoji_events', category: 'dsa' },
  { id: 'github_first', title: 'Git Started', description: 'Connect your GitHub account', icon: 'merge_type', category: 'project' },
  { id: 'github_100_commits', title: 'Committer', description: '100+ GitHub commits in 30 days', icon: 'keep', category: 'project' },
  { id: 'opensource_pr', title: 'Open Source Contributor', description: 'Log your first Open Source activity', icon: 'group', category: 'project' },
  { id: 'all_integrations', title: 'Full Stack', description: 'Connect all 3 integrations (LeetCode, Codeforces, GitHub)', icon: 'link', category: 'integration' },
  { id: 'readiness_50', title: 'On the Map', description: 'Reach Market Readiness 50+', icon: 'trending_up', category: 'readiness' },
  { id: 'readiness_80', title: 'Market Ready', description: 'Reach Market Readiness 80+', icon: 'verified', category: 'readiness' },
  { id: 'first_project', title: 'Builder', description: 'Log a Project activity', icon: 'terminal', category: 'project' },
  { id: 'first_oss_activity', title: 'Open Source', description: 'Log an Open Source activity', icon: 'group', category: 'project' },
];

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export class AchievementsService {
  private cache = new Map<string, CacheEntry<Achievement[]>>();
  private inFlight = new Map<string, Promise<Achievement[]>>();
  private readonly CACHE_TTL_MS = 60 * 1000; // 1 minute cache

  async getAll(userId: string): Promise<Achievement[]> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }
    if (this.inFlight.has(userId)) {
      return this.inFlight.get(userId)!;
    }

    const promise = (async () => {
      try {
        const result = await this.getAllInternal(userId);
        this.cache.set(userId, { data: result, timestamp: Date.now() });
        return result;
      } finally {
        this.inFlight.delete(userId);
      }
    })();

    this.inFlight.set(userId, promise);
    return promise;
  }

  private async getAllInternal(userId: string): Promise<Achievement[]> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        totalXP: true, currentStreak: true, longestStreak: true,
        createdAt: true, leetcodeUsername: true, codeforcesHandle: true,
        githubUsername: true,
      },
    });
    if (!user) return [];

    const activityCount = await prisma.activity.count({ where: { userId } });
    const hasProject = await prisma.activity.findFirst({ where: { userId, category: 'PROJECT' } });
    const hasOSS = await prisma.activity.findFirst({ where: { userId, category: 'OPEN_SOURCE' } });

    // LeetCode stats
    let leetCodeSolved = 0;
    if (user.leetcodeUsername) {
      try {
        const { leetCodeService } = await import('../integrations/leetcode/leetcode.service.js');
        const profile = await leetCodeService.getProfile(userId, user.leetcodeUsername);
        leetCodeSolved = profile.totalSolved;
      } catch {}
    }

    // Codeforces rating
    let cfRating = 0;
    if (user.codeforcesHandle) {
      try {
        const { codeforcesService } = await import('../integrations/codeforces/codeforces.service.js');
        const profile = await codeforcesService.getProfile(userId, user.codeforcesHandle);
        cfRating = profile.rating;
      } catch {}
    }

    // GitHub commits
    let ghCommits = 0;
    if (user.githubUsername) {
      try {
        const { gitHubService } = await import('../integrations/github/github.service.js');
        const activity = await gitHubService.getActivity(userId, user.githubUsername);
        ghCommits = activity.commitsLast30Days;
      } catch {}
    }

    // Market readiness
    let readiness = 0;
    try {
      const mr = await marketReadinessService.compute(userId);
      readiness = mr.overall;
    } catch {}

    const level = Math.floor(user.totalXP / 1000) + 1;

    const checks: Record<string, boolean> = {
      first_activity: activityCount >= 1,
      streak_7: user.longestStreak >= 7,
      streak_30: user.longestStreak >= 30,
      xp_100: user.totalXP >= 100,
      xp_1000: user.totalXP >= 1000,
      xp_5000: user.totalXP >= 5000,
      level_10: level >= 10,
      level_25: level >= 25,
      leetcode_first: !!user.leetcodeUsername,
      leetcode_100: leetCodeSolved >= 100,
      codeforces_first: !!user.codeforcesHandle,
      codeforces_specialist: cfRating >= 1400,
      github_first: !!user.githubUsername,
      github_100_commits: ghCommits >= 100,
      opensource_pr: !!hasOSS,
      all_integrations: !!(user.leetcodeUsername && user.codeforcesHandle && user.githubUsername),
      readiness_50: readiness >= 50,
      readiness_80: readiness >= 80,
      first_project: !!hasProject,
      first_oss_activity: !!hasOSS,
    };

    const progressMap: Record<string, { current: number; target: number } | undefined> = {
      xp_100: user.totalXP < 100 ? { current: user.totalXP, target: 100 } : undefined,
      xp_1000: user.totalXP < 1000 ? { current: user.totalXP, target: 1000 } : undefined,
      xp_5000: user.totalXP < 5000 ? { current: user.totalXP, target: 5000 } : undefined,
      level_10: level < 10 ? { current: level, target: 10 } : undefined,
      level_25: level < 25 ? { current: level, target: 25 } : undefined,
      leetcode_100: leetCodeSolved < 100 ? { current: leetCodeSolved, target: 100 } : undefined,
      streak_7: user.longestStreak < 7 ? { current: user.longestStreak, target: 7 } : undefined,
      streak_30: user.longestStreak < 30 ? { current: user.longestStreak, target: 30 } : undefined,
      github_100_commits: ghCommits < 100 ? { current: ghCommits, target: 100 } : undefined,
    };

    return ACHIEVEMENT_DEFS.map(def => ({
      ...def,
      unlocked: checks[def.id] || false,
      unlockedAt: undefined,
      progress: progressMap[def.id],
    }));
  }

  async getCount(userId: string): Promise<number> {
    const all = await this.getAll(userId);
    return all.filter(a => a.unlocked).length;
  }
}

export const achievementsService = new AchievementsService();
