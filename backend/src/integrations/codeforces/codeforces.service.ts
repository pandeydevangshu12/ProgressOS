import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import { 
  CFUserInfo, 
  CFUserRatingChange, 
  CFApiResponse, 
  CFProfileResponse, 
  CFRatingHistoryResponse, 
  CFStatusResponse,
  CacheEntry,
  CFSubmission,
  CFAnalyticsResponse,
  CFRecentSolve,
  CFRecentAction,
  CFBlogPostResponse
} from './codeforces.types.js';

export class CodeforcesService {
  private cache = new Map<string, CacheEntry<any>>();
  private inFlight = new Map<string, Promise<any>>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Helper to execute fetch with timeout and standard User-Agent.
   */
  private async fetchWithTimeout(url: string, timeoutMs = 3500): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ProgressOS-App/1.0 (https://progressos.devangshupandey84.workers.dev)',
          'Accept': 'application/json',
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Helper to retrieve from cache or fetch and update cache, deduplicating concurrent in-flight requests.
   */
  private async getOrFetch<T>(
    cacheKey: string,
    fetchFn: () => Promise<T>
  ): Promise<T> {
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
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now(),
        });
        return data;
      } finally {
        this.inFlight.delete(cacheKey);
      }
    })();

    this.inFlight.set(cacheKey, promise);
    return promise;
  }

  /**
   * Update the user's codeforcesLastSync timestamp in the database.
   */
  private async updateSyncTime(userId: string): Promise<void> {
    try {
      await prisma.user.update({
        where: { id: userId },
        data: { codeforcesLastSync: new Date() },
      });
    } catch (err) {
      console.error('Failed to update Codeforces sync time:', err);
    }
  }

  /**
   * Get Codeforces user profile info.
   */
  async getProfile(userId: string, handle: string): Promise<CFProfileResponse> {
    const cacheKey = `profile_${userId}_${handle.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const url = `https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`;
        const response = await this.fetchWithTimeout(url);
        
        if (!response.ok) {
          throw AppError.badRequest(`Codeforces API returned HTTP ${response.status}`);
        }

        const data = (await response.json()) as CFApiResponse<CFUserInfo[]>;
        if (data.status !== 'OK' || !data.result || data.result.length === 0) {
          throw AppError.notFound(data.comment || 'Codeforces user not found');
        }

        const user = data.result[0];
        let avatar = user.avatar;
        if (avatar && avatar.startsWith('//')) {
          avatar = 'https:' + avatar;
        }

        const profile: CFProfileResponse = {
          rating: user.rating ?? 0,
          maxRating: user.maxRating ?? 0,
          rank: user.rank ?? 'unrated',
          maxRank: user.maxRank ?? 'unrated',
          avatar: avatar,
          handle: user.handle,
        };

        // Update database sync timestamp
        await this.updateSyncTime(userId);

        return profile;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch Codeforces profile');
      }
    });
  }

  /**
   * Get Codeforces user rating changes.
   */
  async getRatingHistory(userId: string, handle: string): Promise<CFRatingHistoryResponse[]> {
    const cacheKey = `history_${userId}_${handle.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const url = `https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`;
        const response = await this.fetchWithTimeout(url);

        if (!response.ok) {
          throw AppError.badRequest(`Codeforces API returned HTTP ${response.status}`);
        }

        const data = (await response.json()) as CFApiResponse<CFUserRatingChange[]>;
        if (data.status !== 'OK') {
          throw AppError.notFound(data.comment || 'Failed to fetch Codeforces rating history');
        }

        const history: CFRatingHistoryResponse[] = data.result.map((item) => ({
          contest: item.contestName,
          rating: item.newRating,
          change: item.newRating - item.oldRating,
          date: new Date(item.ratingUpdateTimeSeconds * 1000).toISOString(),
        }));

        // Update database sync timestamp
        await this.updateSyncTime(userId);

        return history;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch Codeforces rating history');
      }
    });
  }

  /**
   * Get internal Codeforces connection status of the user.
   */
  async getStatus(userId: string): Promise<CFStatusResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        codeforcesHandle: true,
        codeforcesLastSync: true,
      },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    return {
      connected: !!user.codeforcesHandle,
      codeforcesHandle: user.codeforcesHandle,
      codeforcesLastSync: user.codeforcesLastSync ? user.codeforcesLastSync.toISOString() : null,
    };
  }

  /**
   * Get Codeforces user submissions analytics.
   */
  async getAnalytics(userId: string, handle: string): Promise<CFAnalyticsResponse> {
    const cacheKey = `analytics_${userId}_${handle.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const url = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}`;
        const response = await this.fetchWithTimeout(url);

        if (!response.ok) {
          throw AppError.badRequest(`Codeforces API returned HTTP ${response.status}`);
        }

        const data = (await response.json()) as CFApiResponse<CFSubmission[]>;
        if (data.status !== 'OK') {
          throw AppError.notFound(data.comment || 'Failed to fetch Codeforces submission status');
        }

        const submissions = data.result || [];

        // 1. Unique solved problems (deduplicated where verdict === 'OK')
        const solvedProblemsMap = new Map<string, CFSubmission>();
        submissions.forEach((sub) => {
          if (sub.verdict === 'OK') {
            const key = sub.contestId && sub.problem.index 
              ? `${sub.contestId}_${sub.problem.index}`
              : sub.problem.name;
            const existing = solvedProblemsMap.get(key);
            if (!existing || sub.creationTimeSeconds > existing.creationTimeSeconds) {
              solvedProblemsMap.set(key, sub);
            }
          }
        });

        const uniqueSolves = Array.from(solvedProblemsMap.values());
        const solvedCount = uniqueSolves.length;

        // 2. Difficulty distribution
        const difficultyDistribution: Record<number, number> = {};
        uniqueSolves.forEach((sub) => {
          const rating = sub.problem.rating;
          if (rating !== undefined) {
            difficultyDistribution[rating] = (difficultyDistribution[rating] || 0) + 1;
          }
        });

        // 3. Strongest rating bucket
        const buckets = [
          { label: '800-999', min: 800, max: 999 },
          { label: '1000-1199', min: 1000, max: 1199 },
          { label: '1200-1399', min: 1200, max: 1399 },
          { label: '1400-1599', min: 1400, max: 1599 },
          { label: '1600-1799', min: 1600, max: 1799 },
          { label: '1800-1999', min: 1800, max: 1999 },
          { label: '2000-2199', min: 2000, max: 2199 },
          { label: '2200-2399', min: 2200, max: 2399 },
          { label: '2400-2599', min: 2400, max: 2599 },
          { label: '>= 2600', min: 2600, max: 99999 },
        ];

        const bucketCounts: Record<string, number> = {};
        buckets.forEach(b => { bucketCounts[b.label] = 0; });

        uniqueSolves.forEach((sub) => {
          const rating = sub.problem.rating;
          if (rating !== undefined) {
            const bucket = buckets.find(b => rating >= b.min && rating <= b.max);
            if (bucket) {
              bucketCounts[bucket.label]++;
            }
          }
        });

        let strongestBucket = 'None';
        let maxCount = 0;
        Object.entries(bucketCounts).forEach(([label, count]) => {
          if (count > maxCount) {
            maxCount = count;
            strongestBucket = label;
          }
        });

        // 4. Acceptance rate
        const totalSubmissions = submissions.length;
        const acceptedSubmissions = submissions.filter(s => s.verdict === 'OK').length;
        const acceptanceRate = totalSubmissions > 0 
          ? parseFloat(((acceptedSubmissions / totalSubmissions) * 100).toFixed(2))
          : 0;

        // 5. Recent activity (top 5 unique solved problems sorted by solved time)
        const recentActivity: CFRecentSolve[] = uniqueSolves
          .sort((a, b) => b.creationTimeSeconds - a.creationTimeSeconds)
          .slice(0, 5)
          .map((sub) => ({
            problemName: sub.problem.name,
            index: sub.problem.index,
            rating: sub.problem.rating,
            contestId: sub.contestId,
            solvedAt: new Date(sub.creationTimeSeconds * 1000).toISOString(),
          }));

        // 6. Days since last 1700+ solve
        const solves1700Plus = uniqueSolves.filter(sub => sub.problem.rating !== undefined && sub.problem.rating >= 1700);
        let daysSinceLast1700Solve: number | null = null;
        if (solves1700Plus.length > 0) {
          const latest1700Solve = Math.max(...solves1700Plus.map(s => s.creationTimeSeconds));
          const diffMs = Date.now() - latest1700Solve * 1000;
          daysSinceLast1700Solve = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
        }

        // 7. Estimated contests to Expert (1600)
        let profile: CFProfileResponse = { rating: 0, maxRating: 0, rank: 'unrated', maxRank: 'unrated', avatar: '', handle };
        try {
          profile = await this.getProfile(userId, handle);
        } catch {}

        let history: CFRatingHistoryResponse[] = [];
        try {
          history = await this.getRatingHistory(userId, handle);
        } catch {}

        let estimatedContestsToExpert: number | string | null = null;
        const targetRating = 1600;

        if (profile.rating >= targetRating) {
          estimatedContestsToExpert = 0;
        } else {
          const recent = history.slice(-5);
          const ratingGap = targetRating - profile.rating;

          if (recent.length > 0) {
            const totalChange = recent.reduce((sum, h) => sum + h.change, 0);
            const avgChange = totalChange / recent.length;
            if (avgChange > 0) {
              estimatedContestsToExpert = Math.ceil(ratingGap / avgChange);
            } else {
              estimatedContestsToExpert = Math.ceil(ratingGap / 15);
            }
          } else {
            estimatedContestsToExpert = Math.ceil(ratingGap / 15);
          }
        }

        // 8. Calculate DSA Score (0-100)
        const dsaScore = this.calculateDSAScore(
          profile.rating,
          profile.maxRating,
          solvedCount,
          history.length,
          recentActivity
        );

        // Update database sync timestamp
        await this.updateSyncTime(userId);

        return {
          solvedCount,
          difficultyDistribution,
          strongestBucket,
          acceptanceRate,
          recentActivity,
          daysSinceLast1700Solve,
          estimatedContestsToExpert,
          dsaScore,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to calculate Codeforces analytics');
      }
    });
  }

  /**
   * Get recent blog posts from Codeforces.
   */
  async getRecentBlogPosts(): Promise<CFBlogPostResponse[]> {
    const cacheKey = 'recent_blog_posts';
    return this.getOrFetch(cacheKey, async () => {
      try {
        const url = 'https://codeforces.com/api/recentActions?maxCount=100';
        const response = await this.fetchWithTimeout(url);

        if (!response.ok) {
          throw AppError.badRequest(`Codeforces API returned HTTP ${response.status}`);
        }

        const data = (await response.json()) as CFApiResponse<CFRecentAction[]>;
        if (data.status !== 'OK') {
          throw AppError.notFound(data.comment || 'Failed to fetch Codeforces recent actions');
        }

        const blogPosts: CFBlogPostResponse[] = data.result
          .filter((action) => action.blogEntry)
          .map((action) => ({
            id: action.blogEntry!.id,
            title: action.blogEntry!.title,
            authorHandle: action.blogEntry!.authorHandle,
            creationTimeSeconds: action.blogEntry!.creationTimeSeconds,
            tags: action.blogEntry!.tags,
            rating: action.blogEntry!.rating,
            url: `https://codeforces.com/blog/entry/${action.blogEntry!.id}`,
          }));

        // Deduplicate by blog entry id (newest first)
        const seen = new Set<number>();
        const unique: CFBlogPostResponse[] = [];
        for (const post of blogPosts) {
          if (!seen.has(post.id)) {
            seen.add(post.id);
            unique.push(post);
          }
        }

        return unique.slice(0, 5);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch recent blog posts');
      }
    });
  }

  /**
   * Calculate a deterministic DSA score between 0 and 100 based on Codeforces data.
   */
  calculateDSAScore(
    currentRating: number,
    maxRating: number,
    solvedCount: number,
    contestCount: number,
    recentActivity: CFRecentSolve[]
  ): number {
    // 1. Rating component: up to 45 points (scaled based on 2000 rating)
    const effectiveRating = Math.max(currentRating, maxRating * 0.9);
    const ratingComponent = Math.min(45, (Math.max(0, effectiveRating) / 2000) * 45);

    // 2. Solved count component: up to 30 points (scaled based on 500 solves)
    const solvedComponent = Math.min(30, (solvedCount / 500) * 30);

    // 3. Contest count component: up to 15 points (scaled based on 30 contests)
    const contestComponent = Math.min(15, (contestCount / 30) * 15);

    // 4. Recent activity component: up to 10 points (based on recency of last solve)
    let activityComponent = 0;
    if (recentActivity.length > 0) {
      const latestSolveDate = new Date(recentActivity[0].solvedAt);
      const diffDays = (Date.now() - latestSolveDate.getTime()) / (1000 * 60 * 60 * 24);
      if (diffDays <= 7) {
        activityComponent = 10;
      } else if (diffDays <= 14) {
        activityComponent = 5;
      } else {
        activityComponent = 2;
      }
    }

    const totalScore = Math.round(ratingComponent + solvedComponent + contestComponent + activityComponent);
    return Math.max(0, Math.min(100, totalScore));
  }
}

export const codeforcesService = new CodeforcesService();
