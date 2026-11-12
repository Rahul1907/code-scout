import { Worker } from "bullmq";
import { getConfig } from "../lib/config.js";
import { decryptToken } from "../lib/crypto.js";
import { connectDb, disconnectDb } from "../lib/db.js";
import { Repo } from "../models/repo.js";
import { User } from "../models/user.js";
import {
  getRedisConnection,
  INDEXING_QUEUE_NAME,
  type IndexRepoJobData,
} from "../queues/indexing.js";

async function startWorker(): Promise<void> {
  const config = getConfig();
  await connectDb(config.MONGODB_URI);

  const worker = new Worker<IndexRepoJobData>(
    INDEXING_QUEUE_NAME,
    async (job) => {
      const { repoId, cloneUrl, userId } = job.data;
      console.log(
        JSON.stringify({
          level: "info",
          service: "worker",
          msg: "Processing indexing job",
          jobId: job.id,
          repoId,
        }),
      );

      let token: string | undefined;
      const user = await User.findById(userId).lean();
      if (user?.accessTokenEncrypted) {
        token = decryptToken(user.accessTokenEncrypted, config.TOKEN_ENCRYPTION_KEY);
      }

      const res = await fetch(`${config.AGENT_URL}/internal/index`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Key": config.INTERNAL_API_KEY,
        },
        body: JSON.stringify({
          repoId,
          cloneUrl,
          token,
        }),
        signal: AbortSignal.timeout(15 * 60 * 1000),
      });

      if (!res.ok) {
        const body = await res.text();
        await Repo.findByIdAndUpdate(repoId, {
          $set: {
            status: "failed",
            error: `Agent indexing failed (${res.status}): ${body}`,
          },
        });
        throw new Error(`Agent indexing failed (${res.status}): ${body}`);
      }
    },
    {
      connection: getRedisConnection(),
      concurrency: 2,
    },
  );

  worker.on("completed", (job) => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "worker",
        msg: "Indexing job completed",
        jobId: job.id,
        repoId: job.data.repoId,
      }),
    );
  });

  worker.on("failed", (job, err) => {
    console.error(
      JSON.stringify({
        level: "error",
        service: "worker",
        msg: "Indexing job failed",
        jobId: job?.id,
        repoId: job?.data.repoId,
        error: err.message,
      }),
    );
  });

  console.log(
    JSON.stringify({
      level: "info",
      service: "worker",
      msg: `BullMQ worker listening on queue ${INDEXING_QUEUE_NAME}`,
    }),
  );

  async function shutdown(signal: string): Promise<void> {
    console.log(JSON.stringify({ level: "info", service: "worker", msg: `Shutting down on ${signal}` }));
    await worker.close();
    await disconnectDb();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

startWorker().catch((err) => {
  console.error(JSON.stringify({ level: "error", service: "worker", msg: "Worker startup failed", error: String(err) }));
  process.exit(1);
});
