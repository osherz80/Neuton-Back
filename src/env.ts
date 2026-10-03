import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SUPABASE_URL: z.string().url().min(1, 'SUPABASE_URL is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
  UPSTASH_REDIS_URL: z.string().min(1, 'UPSTASH_REDIS_URL is required'),

  R2_ACCOUNT_ID: z.string().min(1, 'R2_ACCOUNT_ID is required'),
  R2_ACCESS_KEY_ID: z.string().min(1, 'R2_ACCESS_KEY_ID is required'),
  R2_SECRET_ACCESS_KEY: z.string().min(1, 'R2_SECRET_ACCESS_KEY is required'),
  R2_BUCKET_NAME: z.string().min(1, 'R2_BUCKET_NAME is required'),

  GRAFANA_LOG_URL: z.string().url().default('http://localhost:9999/loki/api/v1/push'),

  GEMINI_API_KEY: z.string().min(1, 'GEMINI_API_KEY is required'),

  /**
   * Vision models tried in order when one is out of capacity. Comma separated;
   * the first is the default and each retry rotates to the next.
   */
  GEMINI_MODELS: z
    .string()
    .default(
      [
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.1-flash-lite-preview',
        'gemini-3.1-pro-preview',
        'gemini-3-flash-preview',
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemma-4-26b-a4b-it',
        'gemma-4-31b-it',
      ].join(','),
    ),
  /**
   * Distinct models tried per job attempt. Each failure sidelines that model,
   * so these are picks from the un-flagged remainder rather than repeats.
   */
  GEMINI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(4).default(2),
  /** Backoff before the first retry, in ms. Doubles up to GEMINI_RETRY_MAX_DELAY_MS. */
  GEMINI_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  GEMINI_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).default(10_000),
  /**
   * How long a model that just failed is sidelined, in ms. Must exceed the
   * Gemini capacity blip being waited out, or every pick is a re-pick.
   */
  GEMINI_MODEL_FLAG_TTL_MS: z.coerce.number().int().min(1_000).default(120_000),

  /** Origins allowed to call the API with credentials. Comma separated. */
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  /** Presigned R2 upload lifetime in seconds. */
  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  /** Hard cap on a single uploaded receipt document, in bytes. */
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  /** Global API rate limit (requests per window). */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  /** BullMQ concurrency for the receipt vision pipeline. */
  RECEIPT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Max time a receipt can spend in processing before being marked as failed (ms). */
  RECEIPT_PROCESSING_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  /** Circuit breaker: trip after this many consecutive Gemini failures across all jobs. */
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(10),
  /** Circuit breaker: time (ms) to keep the circuit open before allowing a probe request. */
  CIRCUIT_BREAKER_RESET_MS: z.coerce.number().int().positive().default(60_000),
  /** Allow the queue to be used when Redis is unreachable (dev convenience). */
  QUEUE_OPTIONAL: boolish.default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;

export type Env = typeof env;

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';

export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
