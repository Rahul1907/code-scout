import { createApp } from "./app.js";
import { getConfig } from "./lib/config.js";
import { connectDb } from "./lib/db.js";

async function start(): Promise<void> {
  const config = getConfig();
  await connectDb(config.MONGODB_URI);

  const app = createApp();
  app.listen(config.PORT, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        level: "info",
        service: "api",
        msg: `API listening on port ${config.PORT}`,
      }),
    );
  });
}

start().catch((err) => {
  console.error(JSON.stringify({ level: "error", service: "api", msg: "Startup failed", error: String(err) }));
  process.exit(1);
});
