import dotenv from 'dotenv';
import { z } from 'zod';

// Load .env only in the local Node.js environment.
// Cloudflare Workers and Vercel inject environment variables directly.
if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

const envSchema = z.object({
  PORT: z.coerce.number().default(5000),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  DATABASE_URL: z.string().optional(),

  CLERK_SECRET_KEY: z.string().optional().default(''),

  CLERK_PUBLISHABLE_KEY: z.string().optional(),

  VIT_ENCRYPTION_KEY: z
    .string()
    .default('dev-fallback-key-change-in-production'),

  VIT_SYNC_INTERVAL_HOURS: z.coerce.number().default(6),

  GEMINI_API_KEY: z.string().default(''),

  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);

  throw new Error(
    `Invalid environment variables: ${JSON.stringify(
      parsed.error.flatten().fieldErrors
    )}`
  );
}

export const env = parsed.data;