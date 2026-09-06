import type { JobContext } from '../../../types/job-context.js';
import type { ResumeContext, ResumeContextProject } from '../../../types/resume-context.js';
import type { SectionScore, RecommendedProject } from '../../../types/job-intelligence.types.js';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]+/g, '');
}

function tokenSet(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[\s,/()\-]+/)
      .filter(t => t.length > 1)
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

export function matchProjects(context: ResumeContext, job: JobContext): {
  score: SectionScore;
  recommendedProjects: RecommendedProject[];
} {
  const projects = context.sections.projects || [];
  const jobTerms = tokenSet([
    ...job.requiredSkills,
    ...job.preferredSkills,
    ...job.keywords,
    ...job.responsibilities,
  ].join(' '));

  const projectScores = projects.map(p => {
    const projText = [p.title, p.description || '', ...p.techStack, ...p.bullets].join(' ');
    const projTerms = tokenSet(projText);
    const sim = jaccardSimilarity(jobTerms, projTerms);

    const matchingTech = (p.techStack || []).filter(t =>
      job.requiredSkills.some(rs => normalize(rs) === normalize(t)) ||
      job.preferredSkills.some(ps => normalize(ps) === normalize(t))
    );

    return { project: p, similarity: sim, matchingTech };
  });

  const sorted = [...projectScores].sort((a, b) => b.similarity - a.similarity);

  const relevant = sorted.filter(s => s.similarity > 0.05);
  const recommendedProjects: RecommendedProject[] = relevant.map(s => ({
    projectId: s.project.id,
    title: s.project.title,
    relevance: Math.round(s.similarity * 100),
    confidence: Math.min(95, Math.round(s.similarity * 100 + 10)),
    matchingTechnologies: s.matchingTech,
  }));

  const matched = recommendedProjects.length;
  const total = projects.length;

  const scoreValue = total > 0
    ? Math.round(recommendedProjects.reduce((sum, r) => sum + r.relevance, 0) / total)
    : 0;

  return {
    score: { score: scoreValue, total, matched },
    recommendedProjects,
  };
}
