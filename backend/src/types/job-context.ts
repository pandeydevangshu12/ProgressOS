export interface JobContextMetadata {
  company: string;
  role: string;
  seniority: string;
  employmentType: string;
  location: string;
  remote: boolean;
  salary: string | null;
}

export interface JobContext {
  metadata: JobContextMetadata;
  requiredSkills: string[];
  preferredSkills: string[];
  responsibilities: string[];
  keywords: string[];
}
