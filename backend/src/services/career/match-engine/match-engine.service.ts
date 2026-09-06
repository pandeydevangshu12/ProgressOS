import type { JobContext } from '../../../types/job-context.js';
import type { ResumeContext } from '../../../types/resume-context.js';
import type { MatchReport, RecommendedCertificate } from '../../../types/job-intelligence.types.js';
import { matchSkills, buildKeywordHeatmap } from './skill-matcher.js';
import { matchProjects } from './project-matcher.js';
import { matchEducation } from './education-matcher.js';
import { matchExperience } from './experience-matcher.js';

const SECTION_WEIGHTS: Record<string, number> = {
  skills: 0.35,
  projects: 0.30,
  education: 0.20,
  experience: 0.15,
};

export class MatchEngineService {
  computeMatch(context: ResumeContext, job: JobContext): MatchReport {
    const skillsResult = matchSkills(context, job);
    const projectsResult = matchProjects(context, job);
    const educationScore = matchEducation(context);
    const experienceScore = matchExperience(context);

    const sections: Record<string, { score: number; total: number; matched: number }> = {
      skills: skillsResult.score,
      projects: projectsResult.score,
      education: educationScore,
      experience: experienceScore,
    };

    const overall = Math.round(
      Object.entries(SECTION_WEIGHTS).reduce((sum, [key, weight]) => {
        const section = sections[key];
        return sum + (section ? section.score * weight : 0);
      }, 0)
    );

    const keywordHeatmap = buildKeywordHeatmap(context, job);

    const warnings: string[] = [];
    if (skillsResult.missingSkills.length > 3) {
      warnings.push(`${skillsResult.missingSkills.length} required skills are missing from your resume.`);
    }
    if (projectsResult.recommendedProjects.length === 0) {
      warnings.push('No projects match this job description. Consider adding relevant projects.');
    }
    if (educationScore.score < 50) {
      warnings.push('Education section is incomplete or missing.');
    }
    if (!context.sections.profile.bio || context.sections.profile.bio.length < 20) {
      warnings.push('Professional summary is missing or too short.');
    }

    const recommendedCertificates: RecommendedCertificate[] =
      (context.sections.certificates || []).map(c => ({
        certificateId: c.id,
        name: c.name,
        relevance: 50,
      }));

    return {
      overall,
      sections,
      missingSkills: skillsResult.missingSkills,
      recommendedProjects: projectsResult.recommendedProjects,
      recommendedCertificates,
      keywordHeatmap,
      warnings,
    };
  }
}

export const matchEngineService = new MatchEngineService();
