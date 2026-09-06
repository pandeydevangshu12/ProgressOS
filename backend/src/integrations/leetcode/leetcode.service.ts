import { prisma } from '../../config/database.js';
import { AppError } from '../../utils/AppError.js';
import {
  LCUserProfile, LCContestInfo, LCStatusResponse,
  LCAnalyticsResponse, LCInsightsResponse, LCReadinessResponse,
  CacheEntry
} from './leetcode.types.js';

const LEETCODE_GRAPHQL_URL = 'https://leetcode.com/graphql';

const PROFILE_QUERY = `
query getUserProfile($username: String!) {
  matchedUser(username: $username) {
    username
    submitStats {
      acSubmissionNum {
        difficulty
        count
      }
    }
    profile {
      ranking
    }
  }
}
`;

const CONTEST_QUERY = `
query userContestRankingInfo($username: String!) {
  userContestRanking(username: $username) {
    rating
    globalRanking
    attendedContestsCount
  }
  userContestRankingHistory(username: $username) {
    contest {
      title
    }
    rating
    ranking
    attended
  }
}
`;

export class LeetCodeService {
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
        data: { leetcodeLastSync: new Date() },
      });
    } catch (err) {
      console.error('Failed to update LeetCode sync time:', err);
    }
  }

  private async graphQLQuery<T>(query: string, variables: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);

    let response: Response;
    try {
      response = await fetch(LEETCODE_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw AppError.badRequest('LeetCode API timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw AppError.badRequest(`LeetCode GraphQL API returned HTTP ${response.status}`);
    }

    const json: any = await response.json();
    if (json.errors) {
      throw AppError.notFound(json.errors[0]?.message || 'LeetCode user not found');
    }

    return json.data as T;
  }

  async getProfile(userId: string, username: string): Promise<LCUserProfile> {
    const cacheKey = `lc_profile_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      try {
        const data = await this.graphQLQuery<{ matchedUser: any }>(PROFILE_QUERY, { username });

        if (!data.matchedUser) {
          throw AppError.notFound(`LeetCode user "${username}" not found`);
        }

        const submitStats = data.matchedUser.submitStats || { acSubmissionNum: [] };
        const counts: Record<string, number> = {};
        for (const item of submitStats.acSubmissionNum || []) {
          counts[item.difficulty.toLowerCase()] = item.count;
        }

        const profile: LCUserProfile = {
          username: data.matchedUser.username,
          totalSolved: counts.all || 0,
          easy: counts.easy || 0,
          medium: counts.medium || 0,
          hard: counts.hard || 0,
          ranking: data.matchedUser.profile?.ranking || 0,
        };

        // Store a snapshot for velocity tracking
        const contest = await this.getContestInfoRaw(username);
        await this.storeSnapshot(userId, profile.totalSolved, contest.rating);

        await this.updateSyncTime(userId);
        return profile;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw AppError.badRequest(error instanceof Error ? error.message : 'Failed to fetch LeetCode profile');
      }
    });
  }

  private async getContestInfoRaw(username: string): Promise<LCContestInfo> {
    try {
      const data = await this.graphQLQuery<{ userContestRanking: any; userContestRankingHistory: any[] }>(CONTEST_QUERY, { username });
      const ranking = data.userContestRanking;
      const history = data.userContestRankingHistory || [];

      if (ranking) {
        return {
          rating: ranking.rating || 0,
          globalRanking: ranking.globalRanking || 0,
          attendedContestsCount: ranking.attendedContestsCount || 0,
        };
      }

      const attended = history.filter((h: any) => h.attended);
      const latest = attended.length > 0 ? attended[attended.length - 1] : null;
      return {
        rating: latest ? latest.rating || 0 : 0,
        globalRanking: 0,
        attendedContestsCount: attended.length,
      };
    } catch {
      return { rating: 0, globalRanking: 0, attendedContestsCount: 0 };
    }
  }

  async getContestInfo(userId: string, username: string): Promise<LCContestInfo> {
    const cacheKey = `lc_contest_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      const contest = await this.getContestInfoRaw(username);
      await this.updateSyncTime(userId);
      return contest;
    });
  }

  private async storeSnapshot(userId: string, totalSolved: number, contestRating: number): Promise<void> {
    try {
      // Check if a snapshot already exists for today
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const existing = await prisma.leetCodeSnapshot.findFirst({
        where: {
          userId,
          createdAt: { gte: today, lt: tomorrow },
        },
      });

      if (!existing) {
        await prisma.leetCodeSnapshot.create({
          data: { userId, totalSolved, contestRating: contestRating || null },
        });
      }
    } catch (err) {
      console.error('Failed to store LeetCode snapshot:', err);
    }
  }

  async getAnalytics(userId: string, username: string): Promise<LCAnalyticsResponse> {
    const cacheKey = `lc_analytics_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      const profile = await this.getProfile(userId, username);
      const { easy, medium, hard, totalSolved } = profile;
      const total = totalSolved || 1;

      const problemDistribution = {
        easyPercentage: Math.round((easy / total) * 100),
        mediumPercentage: Math.round((medium / total) * 100),
        hardPercentage: Math.round((hard / total) * 100),
      };

      let difficultyProfile: 'Advanced' | 'Intermediate' | 'Beginner' = 'Beginner';
      if (problemDistribution.hardPercentage > 20) difficultyProfile = 'Advanced';
      else if (problemDistribution.mediumPercentage > 60) difficultyProfile = 'Intermediate';

      // Velocity from snapshots
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const snapshots = await prisma.leetCodeSnapshot.findMany({
        where: { userId, createdAt: { gte: thirtyDaysAgo } },
        orderBy: { createdAt: 'asc' },
      });

      let monthlyGrowth = 0;
      let weeklyAverage = 0;

      if (snapshots.length >= 2) {
        monthlyGrowth = snapshots[snapshots.length - 1].totalSolved - snapshots[0].totalSolved;
        weeklyAverage = Math.round(monthlyGrowth / 4.28);
      }

      // Goal prediction
      let goalPrediction: LCAnalyticsResponse['goalPrediction'] = null;
      // The caller can pass target via query param; we use a sensible default of 700
      const defaultTarget = 700;
      if (totalSolved < defaultTarget && weeklyAverage > 0) {
        const remaining = defaultTarget - totalSolved;
        const estimatedWeeks = Math.ceil(remaining / weeklyAverage);
        const completionDate = new Date();
        completionDate.setDate(completionDate.getDate() + estimatedWeeks * 7);
        goalPrediction = {
          estimatedWeeks,
          estimatedCompletion: completionDate.toISOString().split('T')[0],
        };
      }

      return { problemDistribution, difficultyProfile, monthlyGrowth, weeklyAverage, goalPrediction };
    });
  }

  async getInsights(userId: string, username: string): Promise<LCInsightsResponse> {
    const cacheKey = `lc_insights_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      const profile = await this.getProfile(userId, username);
      const { easy, medium, hard, totalSolved } = profile;

      // Strongest / Weakest category
      const categories = [
        { name: 'Easy Problems', count: easy },
        { name: 'Medium Problems', count: medium },
        { name: 'Hard Problems', count: hard },
      ];
      categories.sort((a, b) => b.count - a.count);
      const strongestCategory = categories[0]?.name || 'N/A';
      const weakestCategory = categories[categories.length - 1]?.name || 'N/A';

      // Progress insight
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const snapshots = await prisma.leetCodeSnapshot.findMany({
        where: { userId, createdAt: { gte: thirtyDaysAgo } },
        orderBy: { createdAt: 'asc' },
      });

      let progressInsight = `You have solved ${totalSolved} problems total.`;
      if (snapshots.length >= 2) {
        const growth = snapshots[snapshots.length - 1].totalSolved - snapshots[0].totalSolved;
        progressInsight = `You solved ${growth} problems in the last 30 days.`;
      }

      // Recommendation
      const hardPct = totalSolved > 0 ? (hard / totalSolved) * 100 : 0;
      let recommendation = '';
      if (hardPct < 15) {
        const needed = Math.ceil(totalSolved * 0.2 - hard);
        recommendation = `Solve ${Math.max(1, needed)} more Hard problems to increase DSA Readiness by approximately 3 points.`;
      } else if (medium < easy && totalSolved > 20) {
        recommendation = 'Focus on Medium problems to build deeper problem-solving skills.';
      } else if (snapshots.length < 2) {
        recommendation = 'Sync regularly to get personalized recommendations.';
      } else {
        recommendation = `Great consistency! Keep solving ${categories[0]?.name?.toLowerCase() || 'problems'} to maintain your growth.`;
      }

      return { strongestCategory, weakestCategory, progressInsight, recommendation };
    });
  }

  async getReadiness(userId: string, username: string): Promise<LCReadinessResponse> {
    const cacheKey = `lc_readiness_${userId}_${username.toLowerCase()}`;
    return this.getOrFetch(cacheKey, async () => {
      const profile = await this.getProfile(userId, username);
      const contest = await this.getContestInfo(userId, username);
      const { totalSolved, hard } = profile;
      const { rating } = contest;

      // Solved count score (0-40)
      const solvedScore = Math.min(40, Math.round((totalSolved / 700) * 40));

      // Contest rating score (0-25)
      let contestScore = 0;
      if (rating >= 2000) contestScore = 25;
      else if (rating >= 1600) contestScore = 20;
      else if (rating >= 1400) contestScore = 16;
      else if (rating >= 1200) contestScore = 12;
      else contestScore = Math.round((rating / 1200) * 12);

      // Hard problems score (0-15)
      const hardScore = Math.min(15, Math.round((hard / 150) * 15));

      // Consistency score (0-20)
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const snapshotCount = await prisma.leetCodeSnapshot.count({
        where: { userId, createdAt: { gte: thirtyDaysAgo } },
      });
      const consistencyScore = Math.min(20, Math.round((snapshotCount / 30) * 20));

      const dsaReadiness = solvedScore + contestScore + hardScore + consistencyScore;

      return {
        dsaReadiness,
        breakdown: {
          solvedCountScore: solvedScore,
          contestRatingScore: contestScore,
          hardProblemsScore: hardScore,
          consistencyScore,
        },
      };
    });
  }

  async getCombinedStats(userId: string, username: string): Promise<{ profile: LCUserProfile; contest: LCContestInfo }> {
    const [profile, contest] = await Promise.all([
      this.getProfile(userId, username),
      this.getContestInfo(userId, username),
    ]);
    return { profile, contest };
  }

  async getStatus(userId: string): Promise<LCStatusResponse> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { leetcodeUsername: true, leetcodeLastSync: true },
    });

    if (!user) {
      throw AppError.notFound('User not found');
    }

    return {
      connected: !!user.leetcodeUsername,
      leetcodeUsername: user.leetcodeUsername,
      leetcodeLastSync: user.leetcodeLastSync ? user.leetcodeLastSync.toISOString() : null,
    };
  }
}

export const leetCodeService = new LeetCodeService();
