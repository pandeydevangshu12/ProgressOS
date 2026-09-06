import type { PromptModule } from '../../../../types/ai.types.js';
import { RewriteSummaryPrompt } from './rewrite-summary.js';
import { RewriteProjectPrompt } from './rewrite-project.js';
import { QuantifyAchievementPrompt } from './quantify-achievement.js';
import { ExtractJobPrompt } from './extract-job.js';

const prompts = new Map<string, PromptModule>();

function key(section: string, action: string): string {
  return `${section}:${action}`;
}

function register(prompt: PromptModule): void {
  prompts.set(key(prompt.id.split('-')[0], prompt.id.split('-').slice(1).join('-')), prompt);
}

register(RewriteSummaryPrompt);
register(RewriteProjectPrompt);
register(QuantifyAchievementPrompt);
register(ExtractJobPrompt);

// Also register common aliases
prompts.set('summary:improve', RewriteSummaryPrompt);
prompts.set('summary:ats-optimize', RewriteSummaryPrompt);
prompts.set('summary:shorten', RewriteSummaryPrompt);
prompts.set('summary:expand', RewriteSummaryPrompt);
prompts.set('summary:technical', RewriteSummaryPrompt);
prompts.set('summary:beginner-friendly', RewriteSummaryPrompt);
prompts.set('project:improve', RewriteProjectPrompt);
prompts.set('project:quantify', RewriteProjectPrompt);
prompts.set('project:action-verbs', RewriteProjectPrompt);
prompts.set('project:star-format', RewriteProjectPrompt);
prompts.set('project:ats', RewriteProjectPrompt);
prompts.set('achievement:rewrite', QuantifyAchievementPrompt);
prompts.set('achievement:quantify', QuantifyAchievementPrompt);
prompts.set('achievement:recruiter-friendly', QuantifyAchievementPrompt);

export const PromptRegistry = {
  get(section: string, action: string): PromptModule | undefined {
    return prompts.get(key(section, action));
  },

  register(prompt: PromptModule): void {
    register(prompt);
  },
};
