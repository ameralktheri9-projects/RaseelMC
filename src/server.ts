import { createApp } from "./app";
import { config } from "./config";
import { runMigrations } from "./db/migrate";

runMigrations();

const app = createApp();

app.listen(config.port, () => {
  console.log(`Raseel MC running at http://localhost:${config.port}`);
});
