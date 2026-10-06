import { createApp } from "./app";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { scheduleJobs } from "./jobs";

async function main() {
  await runMigrations();

  const app = createApp();

  if (!config.isServerless) {
    scheduleJobs();
  }

  app.listen(config.port, () => {
    console.log(`Raseel MC running at http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
