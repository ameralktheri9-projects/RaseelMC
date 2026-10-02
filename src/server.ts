import { createApp } from "./app";
import { config } from "./config";
import { runMigrations } from "./db/migrate";
import { scheduleJobs } from "./jobs";

runMigrations();

const app = createApp();

scheduleJobs();

app.listen(config.port, () => {
  console.log(`Raseel MC running at http://localhost:${config.port}`);
});
