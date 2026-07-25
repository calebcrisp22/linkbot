import "dotenv/config";
import { startBot } from "./bot.js";

startBot().catch((err) => {
  console.error("Fatal error starting bot:", err);
  process.exit(1);
});
