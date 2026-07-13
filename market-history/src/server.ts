import express from "express";
import cors from "cors";
import { config } from "./config";
import { apiRouter } from "./routes";

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" })); // snapshots can be large

app.get("/health", (_req, res) => res.json({ status: "ok", service: "market-history-engine" }));
app.use("/api", apiRouter);

app.listen(config.port, () => {
  console.log(`[market-history-engine] Listening on port ${config.port} (db=${config.dbPath})`);
});
