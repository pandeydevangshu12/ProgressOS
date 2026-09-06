import { z } from 'zod';
import type { PromptModule } from '../../../../types/ai.types.js';

export const ExtractJobSchema = z.object({
  company: z.string(),
  role: z.string(),
  seniority: z.string(),
  employmentType: z.string(),
  location: z.string(),
  remote: z.boolean(),
  salary: z.string().nullable(),
  requiredSkills: z.array(z.string()),
  preferredSkills: z.array(z.string()),
  responsibilities: z.array(z.string()),
  keywords: z.array(z.string()),
});

export const ExtractJobPrompt: PromptModule<z.infer<typeof ExtractJobSchema>> = {
  id: 'extract-job',
  version: 1,
  temperature: 0.2,

  system() {
    return `You are a job description parser. Extract structured information from the raw job description text below.

Return JSON matching this schema:
{
  "company": string,
  "role": string,
  "seniority": string, // one of: "Intern", "Entry Level", "Junior", "Mid-Level", "Senior", "Lead", "Manager"
  "employmentType": string, // one of: "Full-time", "Part-time", "Contract", "Internship", "Temporary"
  "location": string,
  "remote": boolean,
  "salary": string | null, // include if mentioned (e.g. "$120k-$150k"), null if absent
  "requiredSkills": string[], // skills explicitly listed as requirements or "must-have"
  "preferredSkills": string[], // skills listed as "preferred", "nice-to-have", "plus", "bonus"
  "responsibilities": string[], // key responsibilities and day-to-day tasks
  "keywords": string[] // important buzzwords, domain terms, methodologies (e.g. "Agile", "CI/CD", "Microservices")
}

Extract facts only. Do not infer or guess missing information. Return empty arrays for missing list fields and null for missing optional fields.`;
  },

  user(ctx) {
    return ctx.sections.summary?.bio || '';
  },

  schema: ExtractJobSchema,
};
