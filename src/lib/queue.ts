import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../env.js';

export const QUEUE_NAME = 'neuton-media';

/**
 * Upstash requires TLS and forbids the blocking/`maxRetriesPerRequest` patterns
 * BullMQ needs, so connection options are explicit here.
 */
export function createRedisConnection(): Redis {
  return new Redis(env.UPSTASH_REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
    tls: env.UPSTASH_REDIS_URL.startsWith('rediss://') ? {} : undefined,
  });
}

export type MediaKind = 'receipt' | 'recipe' | 'product' | 'order';

export interface MediaJobData {
  shopId: string;
  uploadedBy: string | null;
  kind: MediaKind;
  storagePath: string;
  contentType: string;
  originalFilename: string | null;
  /** Present for `kind === 'order'`: the order row being auto-filled. */
  orderId?: string;
}

const defaultJobOptions: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 60 * 60 * 24, count: 1_000 },
  removeOnFail: { age: 60 * 60 * 24 * 7 },
};

let queue: Queue<MediaJobData> | null = null;
let queueUnavailable = false;

export function getMediaQueue(): Queue<MediaJobData> {
  if (!queue) {
    queue = new Queue<MediaJobData>(QUEUE_NAME, {
      connection: createRedisConnection(),
      defaultJobOptions: defaultJobOptions,
    });
  }
  return queue;
}

export interface EnqueueResult {
  queued: boolean;
  jobId: string | null;
  reason?: string;
}

export async function enqueueMediaJob(data: MediaJobData): Promise<EnqueueResult> {
  if (queueUnavailable) {
    return { queued: false, jobId: null, reason: 'queue disabled' };
  }
  try {
    const job = await getMediaQueue().add(data.kind, data);
    return { queued: true, jobId: String(job.id) };
  } catch (error) {
    if (env.QUEUE_OPTIONAL) {
      queueUnavailable = true;
      return { queued: false, jobId: null, reason: 'queue unavailable' };
    }
    throw error;
  }
}
