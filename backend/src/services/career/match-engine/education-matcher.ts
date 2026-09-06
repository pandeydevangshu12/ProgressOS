import type { ResumeContext } from '../../../types/resume-context.js';
import type { SectionScore } from '../../../types/job-intelligence.types.js';

export function matchEducation(context: ResumeContext): SectionScore {
  const edu = context.sections.education;

  if (!edu) {
    return { score: 0, total: 1, matched: 0 };
  }

  let matched = 0;
  const checks = [
    edu.institution && edu.institution.length > 0,
    edu.cgpa !== null && edu.cgpa !== undefined,
    edu.creditsEarned !== null && edu.creditsEarned !== undefined,
  ];

  matched = checks.filter(Boolean).length;
  const total = checks.length;

  return {
    score: Math.round((matched / total) * 100),
    total,
    matched,
  };
}
