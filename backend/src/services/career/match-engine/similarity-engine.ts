import type { JobContext } from '../../../types/job-context.js';
import type { ResumeContext } from '../../../types/resume-context.js';
import type { SimilarityScore } from '../../../types/job-intelligence.types.js';
import { matchSkills } from './skill-matcher.js';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]+/g, '');
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[\s,/()\-]+/).filter(t => t.length > 1)
  );
}

function roleSimilarity(targetRole: string | null, jobRole: string): number {
  if (!targetRole) return 0;
  const t = tokenSet(targetRole);
  const j = tokenSet(jobRole);
  if (t.size === 0 || j.size === 0) return 0;
  let intersection = 0;
  for (const item of t) {
    if (j.has(item)) intersection++;
  }
  const union = t.size + j.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function projectTechOverlap(
  projectTechStacks: string[][],
  jobSkills: string[]
): number {
  if (jobSkills.length === 0) return 0;
  const allTech = [...new Set(projectTechStacks.flat().map(normalize))];
  const matched = jobSkills.filter(s => {
    const ns = normalize(s);
    return allTech.some(t => t === ns || t.includes(ns) || ns.includes(t));
  });
  return matched.length / jobSkills.length;
}

function certificateRelevance(
  certificateNames: string[],
  job: JobContext
): number {
  if (certificateNames.length === 0) return 0;
  const allTerms = tokenSet([...job.requiredSkills, ...job.preferredSkills, ...job.keywords].join(' '));
  if (allTerms.size === 0) return 0;
  let matched = 0;
  for (const cert of certificateNames) {
    const certTokens = tokenSet(cert);
    for (const term of allTerms) {
      if (certTokens.has(term)) {
        matched++;
        break;
      }
    }
  }
  return Math.min(1, matched / Math.min(certificateNames.length, 3));
}

interface ScoredProfile {
  profileId: string;
  profileName: string;
  targetRole: string | null;
  context: ResumeContext;
  score: number;
  breakdown: Record<string, number>;
}

export class SimilarityEngine {
  scoreProfile(
    profile: { id: string; name: string; targetRole: string | null },
    context: ResumeContext,
    job: JobContext
  ): ScoredProfile {
    const skillScore = matchSkills(context, job).score.score;

    const roleSim = roleSimilarity(profile.targetRole, job.metadata.role) * 100;
    const techOverlap = projectTechOverlap(
      context.sections.projects.map(p => p.techStack || []),
      [...job.requiredSkills, ...job.preferredSkills]
    ) * 100;
    const certScore = certificateRelevance(
      context.sections.certificates.map(c => c.name),
      job
    ) * 100;

    const breakdown = {
      skills: skillScore * 0.35,
      role: roleSim * 0.25,
      projects: techOverlap * 0.25,
      certificates: certScore * 0.15,
    };

    const score = Math.round(Object.values(breakdown).reduce((a, b) => a + b, 0));

    return {
      profileId: profile.id,
      profileName: profile.name,
      targetRole: profile.targetRole,
      context,
      score,
      breakdown: {
        skills: skillScore,
        role: Math.round(roleSim),
        projects: Math.round(techOverlap),
        certificates: Math.round(certScore),
      },
    };
  }

  scoreProfiles(
    profiles: { id: string; name: string; targetRole: string | null }[],
    contexts: ResumeContext[],
    job: JobContext
  ): SimilarityScore[] {
    return profiles.map((profile, i) => {
      const result = this.scoreProfile(profile, contexts[i], job);
      return {
        profileId: result.profileId,
        profileName: result.profileName,
        score: result.score,
        breakdown: result.breakdown,
      };
    }).sort((a, b) => b.score - a.score);
  }
}

export const similarityEngine = new SimilarityEngine();
