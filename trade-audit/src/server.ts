import express from "express";
import cors from "cors";
import { config } from "./config";
import { tradesRouter } from "./routes/trades";
import { recoverAndStart } from "./queue";
import "./db"; // ensure schema is created before anything else runs

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "trade-audit-engine" }));
app.use("/api", tradesRouter);

// Re-queue anything left mid-flight from a previous crash, then start draining.
recoverAndStart();

app.listen(config.port, () => {
  console.log(`[trade-audit-engine] Listening on port ${config.port}`);
});
