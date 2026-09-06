import type { JobContext } from '../../../types/job-context.js';
import type { ResumeContext } from '../../../types/resume-context.js';
import type { SectionScore, MissingSkill, KeywordHeatmapItem } from '../../../types/job-intelligence.types.js';

interface SkillMatchResult {
  score: SectionScore;
  missingSkills: MissingSkill[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9+#.]+/g, '');
}

function tokenize(s: string): string[] {
  return s.split(/[\s,/]+/).filter(Boolean).map(normalize);
}

function fuzzyMatch(skill: string, resumeSkills: string[]): boolean {
  const normalized = normalize(skill);
  if (!normalized) return false;
  const skillTokens = tokenize(skill);
  return resumeSkills.some(rs => {
    const rn = normalize(rs);
    if (rn === normalized) return true;
    if (rn.includes(normalized) || normalized.includes(rn)) return true;
    const rsTokens = tokenize(rs);
    const overlap = skillTokens.filter(t => rsTokens.some(rt => rt.includes(t) || t.includes(rt)));
    return overlap.length >= Math.min(skillTokens.length, rsTokens.length);
  });
}

function getAllResumeSkills(context: ResumeContext): string[] {
  const fromSkills = context.sections.skills || [];
  const fromProjects = (context.sections.projects || []).flatMap(p => p.techStack || []);
  return [...new Set([...fromSkills, ...fromProjects])];
}

function computePriority(skill: string, isRequired: boolean): 'high' | 'medium' | 'low' {
  if (isRequired) return 'high';
  return 'medium';
}

export function matchSkills(context: ResumeContext, job: JobContext): SkillMatchResult {
  const resumeSkills = getAllResumeSkills(context);

  const requiredMatched = job.requiredSkills.filter(s => fuzzyMatch(s, resumeSkills));
  const preferredMatched = job.preferredSkills.filter(s => fuzzyMatch(s, resumeSkills));
  const totalSkills = job.requiredSkills.length + job.preferredSkills.length;
  const matchedSkills = requiredMatched.length + preferredMatched.length;

  const score = totalSkills > 0 ? Math.round((matchedSkills / totalSkills) * 100) : 0;

  const missingSkills: MissingSkill[] = [
    ...job.requiredSkills
      .filter(s => !fuzzyMatch(s, resumeSkills))
      .map(s => ({ skill: s, category: 'required' as const, priority: computePriority(s, true), confidence: 95 })),
    ...job.preferredSkills
      .filter(s => !fuzzyMatch(s, resumeSkills))
      .map(s => ({ skill: s, category: 'preferred' as const, priority: computePriority(s, false), confidence: 85 })),
  ];

  return {
    score: { score, total: totalSkills, matched: matchedSkills },
    missingSkills,
  };
}

export function buildKeywordHeatmap(context: ResumeContext, job: JobContext): KeywordHeatmapItem[] {
  const resumeSkills = getAllResumeSkills(context);
  const resumeText = [
    context.sections.profile.bio || '',
    ...context.sections.projects.flatMap(p => [p.title, p.description || '', ...p.bullets]),
  ].join(' ').toLowerCase();

  const counted = new Map<string, number>();
  job.keywords.forEach(k => {
    const key = k.toLowerCase();
    counted.set(key, (counted.get(key) || 0) + 1);
  });

  const heatmap: KeywordHeatmapItem[] = [];
  for (const [term, count] of counted) {
    const inResume = fuzzyMatch(term, resumeSkills) || resumeText.includes(term);
    heatmap.push({ term, count, inResume });
  }

  return heatmap.sort((a, b) => b.count - a.count);
}
