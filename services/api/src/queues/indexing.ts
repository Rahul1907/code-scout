import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { getConfig } from "../lib/config.js";

export const INDEXING_QUEUE_NAME = "repo-indexing";

export interface IndexRepoJobData {
  repoId: string;
  cloneUrl: string;
  defaultBranch: string;
  userId: string;
}

let redisConnection: Redis | null = null;
let indexingQueue: Queue<IndexRepoJobData> | null = null;

export function getRedisConnection(): Redis {
  if (redisConnection) return redisConnection;
  const { REDIS_URL } = getConfig();
  redisConnection = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  return redisConnection;
}

export function getIndexingQueue(): Queue<IndexRepoJobData> {
  if (indexingQueue) return indexingQueue;
  indexingQueue = new Queue<IndexRepoJobData>(INDEXING_QUEUE_NAME, {
    connection: getRedisConnection(),
  });
  return indexingQueue;
}

export async function enqueueIndexingJob(data: IndexRepoJobData): Promise<string> {
  const queue = getIndexingQueue();
  const job = await queue.add("index-repo", data, {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  });
  return String(job.id ?? "");
}

export async function closeQueueResources(): Promise<void> {
  if (indexingQueue) {
    await indexingQueue.close();
    indexingQueue = null;
  }
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
  }
}

