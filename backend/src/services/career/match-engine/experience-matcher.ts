import type { ResumeContext } from '../../../types/resume-context.js';
import type { SectionScore } from '../../../types/job-intelligence.types.js';

export function matchExperience(context: ResumeContext): SectionScore {
  const projects = context.sections.projects || [];
  const hasCodingProfiles = (context.sections.codingProfiles || []).some(cp => cp.enabled);
  const hasCertificates = (context.sections.certificates || []).length > 0;
  const hasAchievements = (context.sections.achievements || []).length > 0;

  let matched = 0;
  const total = 4;

  if (projects.length > 0) matched++;
  if (hasCodingProfiles) matched++;
  if (hasCertificates) matched++;
  if (hasAchievements) matched++;

  return {
    score: Math.round((matched / total) * 100),
    total,
    matched,
  };
}
