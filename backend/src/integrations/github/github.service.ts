import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { Category } from '@prisma/client';
import { calculateXP } from '../../config/constants.js';
import {
  GHUserInfo, GHRepository, GHEvent,
  GHProfileResponse, GHRepositorySummary,
  GHActivityResponse, GHAnalyticsResponse,
  GHStatusResponse, GHSyncResponse, CacheEntry
} from './github.types.js';

export class GitHubService {
  private cache = new Map<string, CacheEntry<any>>();
  private inFlight = new Map<string, Promise<any>>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000;

  private async getOrFetch<T>(cacheKey: string, fetchFn: () => Promise<T>, force = false): Promise<T> {
    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        return cached.data;
      }
      if (this.inFlight.has(cacheKey)) {
        return this.inFlight.get(cacheKey)!;
      }
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

  private clearUserCache(userId: string): void {
    const prefix = `gh_${userId}_`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private async updateSyncTime(userId: string): Promise<void> {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { githubLastSync: new Date() },
      });
    } catch (err) {
      console.error('Failed to update GitHub sync time:', err);
    }
  }

  private async fetchGitHub<T>(url: string, token?: string | null): Promise<T> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'ProgressOS-App/1.0 (https://progressos.devangshupandey84.workers.dev)',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    let response: Response;
    try {
      response = await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (response.status === 403) {
        throw AppError.badRequest('GitHub API rate limit exceeded. Try again later or add a GitHub token in settings.');
      }
      if (response.status === 401) {
        throw AppError.badRequest('GitHub token is invalid. Update it in settings.');
      }
      if (response.status === 404) {
        throw AppError.notFound('GitHub user not found');
      }
      throw AppError.badRequest(`GitHub API returned HTTP ${response.status}`);
    }

    return response.json() as Promise<T>;
  }

  private async getUserToken(userId: string): Promise<string | null> {
    try {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { githubToken: true } });
      return u?.githubToken || null;
    } catch {
      return null;
    }
  }

  async getProfile(userId: string, username: string): Promise<GHProfileResponse> {
    const cacheKey = `gh_profile_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const token = await this.getUserToken(userId);
        const user = await this.fetchGitHub<GHUserInfo>(`https://api.github.com/users/${encodeURIComponent(username)}`, token);

        const profile: GHProfileResponse = {
          username: user.login,
          avatarUrl: user.avatar_url,
          profileUrl: user.html_url,
          publicRepos: user.public_repos,
          followers: user.followers,
          following: user.following,
        };

        await this.updateSyncTime(userId);
        return profile;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch GitHub profile');
      }
    });
  }

  async getRepositories(userId: string, username: string): Promise<GHRepositorySummary[]> {
    const cacheKey = `gh_repos_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const token = await this.getUserToken(userId);
        const repos = await this.fetchGitHub<GHRepository[]>(
          `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`, token
        );

        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

        const summaries: GHRepositorySummary[] = repos
          .filter(r => !r.fork)
          .map(r => {
            const lastPushed = new Date(r.pushed_at);
            const isActive = lastPushed >= ninetyDaysAgo;

            let score = 0;
            if (r.description) score += 20;
            score += Math.min(25, Math.round((r.stargazers_count / 5) * 25));
            score += Math.min(15, Math.round((r.forks_count / 3) * 15));
            if (isActive) score += 25;
            if (r.language) score += 15;

            return {
              name: r.name,
              description: r.description,
              url: r.html_url,
              stars: r.stargazers_count,
              forks: r.forks_count,
              language: r.language,
              lastPushed: r.pushed_at,
              isActive,
              score: Math.min(100, score),
            };
          });

        await this.updateSyncTime(userId);
        return summaries;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch GitHub repositories');
      }
    });
  }

  async getActivity(userId: string, username: string): Promise<GHActivityResponse> {
    const cacheKey = `gh_activity_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const repos = await this.getRepositories(userId, username);

        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

        const activeProjects = repos.filter(r => {
          const pushed = new Date(r.lastPushed);
          return pushed >= ninetyDaysAgo;
        }).length;

        let commitsLast30Days = 0;
        let activeDays = 0;

        try {
          const token = await this.getUserToken(userId);
          const events = await this.fetchGitHub<GHEvent[]>(
            `https://api.github.com/users/${encodeURIComponent(username)}/events?per_page=100`, token
          );

          const activeDates = new Set<string>();

          events.forEach(event => {
            const eventDate = new Date(event.created_at);
            if (eventDate >= thirtyDaysAgo) {
              activeDates.add(eventDate.toISOString().split('T')[0]);

              if (event.type === 'PushEvent') {
                commitsLast30Days += event.payload.commits?.filter(c => c.distinct).length || 0;
              }
            }
          });

          activeDays = activeDates.size;
        } catch {
          // If events API fails, estimate from repository push dates
          const uniquePushDays = new Set<string>();
          repos.forEach(r => {
            const pushed = new Date(r.lastPushed);
            if (pushed >= thirtyDaysAgo) {
              uniquePushDays.add(pushed.toISOString().split('T')[0]);
            }
          });
          activeDays = uniquePushDays.size;
          commitsLast30Days = Math.round(activeDays * 2.5);
        }

        const totalStars = repos.reduce((sum, r) => sum + r.stars, 0);
        const totalForks = repos.reduce((sum, r) => sum + r.forks, 0);

        await this.storeSnapshot(userId, repos.length, totalStars, commitsLast30Days);

        return {
          activeProjects,
          commitsLast30Days,
          activeDays,
          totalStars,
          totalForks,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch GitHub activity');
      }
    });
  }

  private async storeSnapshot(userId: string, repoCount: number, stars: number, commits: number): Promise<void> {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const existing = await prisma.gitHubSnapshot.findFirst({
        where: {
          userId,
          createdAt: { gte: today, lt: tomorrow },
        },
      });

      if (!existing) {
        await prisma.gitHubSnapshot.create({
          data: { userId, repoCount, stars, commits },
        });
      }
    } catch (err) {
      console.error('Failed to store GitHub snapshot:', err);
    }
  }

  async getAnalytics(userId: string, username: string): Promise<GHAnalyticsResponse> {
    const cacheKey = `gh_analytics_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const repos = await this.getRepositories(userId, username);
        const activity = await this.getActivity(userId, username);

        // Project Count Score (0-30)
        const projectCountScore = Math.min(30, Math.round((repos.length / 20) * 30));

        // Project Activity Score (0-30)
        const activityRatio = repos.length > 0 ? activity.activeProjects / repos.length : 0;
        const projectActivityScore = Math.min(30, Math.round(activityRatio * 30));

        // Commit Consistency Score (0-20)
        const consistencyRatio = activity.activeDays > 0 ? activity.activeDays / 30 : 0;
        const commitConsistencyScore = Math.min(20, Math.round(consistencyRatio * 20));

        // Repository Quality Score (0-20)
        const avgRepoScore = repos.length > 0
          ? repos.reduce((sum, r) => sum + r.score, 0) / repos.length
          : 0;
        const repositoryQualityScore = Math.min(20, Math.round((avgRepoScore / 100) * 20));

        const projectReadiness = projectCountScore + projectActivityScore + commitConsistencyScore + repositoryQualityScore;

        const topProjects = repos
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map(r => ({ name: r.name, score: r.score }));

        return {
          projectReadiness,
          breakdown: {
            projectCountScore,
            projectActivityScore,
            commitConsistencyScore,
            repositoryQualityScore,
          },
          topProjects,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to calculate GitHub analytics');
      }
    });
  }

  private async getGitHubConfig(userId: string): Promise<{ username: string; token: string | null }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { githubUsername: true, githubToken: true },
    });
    if (!user) throw AppError.notFound('User not found');
    if (!user.githubUsername) throw AppError.badRequest('GitHub username not connected');
    return { username: user.githubUsername, token: user.githubToken };
  }

  async sync(userId: string): Promise<GHSyncResponse> {
    const { username, token } = await this.getGitHubConfig(userId);

    this.clearUserCache(userId);

    const repos = await this.fetchGitHub<GHRepository[]>(
      `https://api.github.com/users/${encodeURIComponent(username)}/repos?per_page=100&sort=pushed`,
      token
    );

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { githubLastSync: true },
    });
    const sinceDate = user?.githubLastSync || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let commitsFound = 0;
    try {
      const events = await this.fetchGitHub<GHEvent[]>(
        `https://api.github.com/users/${encodeURIComponent(username)}/events?per_page=100`,
        token
      );

      const syncThreshold = new Date(sinceDate.getTime() - 60 * 1000);

      const newCommits: string[] = [];
      for (const event of events) {
        if (event.type === 'PushEvent' && new Date(event.created_at) > syncThreshold) {
          const commits = event.payload.commits?.filter(c => c.distinct).map(c => c.message) || [];
          newCommits.push(...commits);
        }
      }
      commitsFound = newCommits.length;
    } catch {
      const activeRepos = repos.filter(r => new Date(r.pushed_at) > sinceDate).length;
      commitsFound = Math.round(activeRepos * 2.5);
    }

    let activityCreated = false;
    if (commitsFound > 0) {
      const hours = Math.max(0.5, Math.min(4, Math.round(commitsFound / 2 * 10) / 10));
      const xp = calculateXP(Category.OPEN_SOURCE, hours);

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const existing = await prisma.activity.findFirst({
        where: {
          userId,
          title: { startsWith: 'GitHub Sync' },
          createdAt: { gte: today, lt: tomorrow },
        },
      });

      if (existing) {
        await prisma.activity.update({
          where: { id: existing.id },
          data: {
            title: `GitHub Sync: ${commitsFound} commits`,
            hours,
            xp,
          },
        });
      } else {
        await prisma.activity.create({
          data: {
            userId,
            title: `GitHub Sync: ${commitsFound} commits`,
            category: Category.OPEN_SOURCE,
            hours,
            xp,
          },
        });

        const now = new Date();
        const lastDate = user?.githubLastSync;
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart);
        yesterdayStart.setDate(yesterdayStart.getDate() - 1);

        let streakDelta = 0;
        if (!lastDate || lastDate < yesterdayStart) {
          streakDelta = 1;
        } else if (lastDate >= yesterdayStart && lastDate < todayStart) {
          const u = await prisma.user.findUnique({ where: { id: userId }, select: { currentStreak: true, longestStreak: true } });
          if (u) {
            streakDelta = u.currentStreak + 1;
            const longestStreak = Math.max(streakDelta, u.longestStreak);
            await prisma.user.update({
              where: { id: userId },
              data: { totalXP: { increment: xp }, lastActiveAt: now, currentStreak: streakDelta, longestStreak },
            });
          }
        } else {
          streakDelta = -1;
        }

        if (streakDelta < 0) {
          await prisma.user.update({
            where: { id: userId },
            data: { totalXP: { increment: xp } },
          });
        }
      }
      activityCreated = true;
    }

    const nonForkRepos = repos.filter(r => !r.fork);
    const totalStars = nonForkRepos.reduce((s, r) => s + r.stargazers_count, 0);
    await this.storeSnapshot(userId, nonForkRepos.length, totalStars, commitsFound);
    await this.updateSyncTime(userId);

    this.clearUserCache(userId);

    return {
      synced: true,
      activityCreated,
      commitsFound,
      activityTitle: activityCreated ? `GitHub Sync: ${commitsFound} commits` : undefined,
      activityXP: activityCreated ? calculateXP(Category.OPEN_SOURCE, Math.max(0.5, Math.min(4, Math.round(commitsFound / 2 * 10) / 10))) : undefined,
    };
  }

  async getStatus(userId: string): Promise<GHStatusResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { githubUsername: true, githubLastSync: true },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    return {
      connected: !!user.githubUsername,
      githubUsername: user.githubUsername,
      githubLastSync: user.githubLastSync ? user.githubLastSync.toISOString() : null,
    };
  }
}

export const gitHubService = new GitHubService();
