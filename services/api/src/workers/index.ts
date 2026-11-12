const redisUrl = process.env.REDIS_URL ?? "redis://redis:6379";

console.log(
  JSON.stringify({
    level: "info",
    service: "worker",
    msg: "Worker initialized (BullMQ queues pending Task 1.4)",
    redisUrl,
  }),
);

const heartbeat = setInterval(() => {
  // Keep worker container alive in Task 1.1 skeleton
}, 30_000);

function shutdown(signal: string): void {
  console.log(JSON.stringify({ level: "info", service: "worker", msg: `Shutting down on ${signal}` }));
  clearInterval(heartbeat);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

