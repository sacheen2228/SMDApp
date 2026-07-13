import { Router, Request, Response } from "express";
import {
  insertSnapshot,
  insertCandles,
  insertScannerResult,
  getScannerResults,
  updateScannerResultOutcome,
  readSnapshotById,
  getSnapshotsForSymbol,
  getSnapshotsSummary,
  getSessionCandles,
  getSnapshotIntegrityRows,
  getSnapshotVersion,
  getTotalSnapshots,
  getLastCaptureTime,
  getDbFileSizeBytes,
  type ScannerResultFilter,
} from "../db";

export const apiRouter = Router();

// Resolve a snapshotId to the latest recorded snapshot for a symbol when
// the caller did not supply one. Falls back to the global latest capture so
// equity/ETF strategies (which are not in RECORDER_SYMBOLS) still attach a
// real snapshot id for version/regime context.
function resolveSnapshotId(symbol: string, snapshotId?: string | null): string {
  if (snapshotId) return snapshotId;
  const ts = getLastCaptureTime(symbol) ?? getLastCaptureTime();
  return ts ? `${symbol}-${ts}` : `${symbol}-${Date.now()}`;
}

// ── Snapshot writes (Recorder) ────────────────────────────────
apiRouter.post("/snapshot", (req: Request, res: Response) => {
  try {
    const snap = req.body?.snapshot;
    if (!snap || !snap.symbol || !snap.timestamp) {
      return res.status(400).json({ error: "invalid_snapshot" });
    }
    const inserted = insertSnapshot(snap);
    return res.json({ success: true, inserted });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

apiRouter.post("/candles", (req: Request, res: Response) => {
  try {
    const { symbol, interval, candles } = req.body ?? {};
    if (!symbol || !interval || !Array.isArray(candles)) {
      return res.status(400).json({ error: "invalid_candles" });
    }
    insertCandles(symbol, interval, candles);
    return res.json({ success: true, count: candles.length });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// ── Scanner results (ML dataset) ─────────────────────────────
apiRouter.post("/scanner", (req: Request, res: Response) => {
  try {
    const list: any[] = Array.isArray(req.body?.results)
      ? req.body.results
      : req.body?.result
      ? [req.body.result]
      : [];
    if (list.length === 0) {
      return res.status(400).json({ error: "no_scanner_results" });
    }
    const recorded: string[] = [];
    for (const r of list) {
      const snapshotId = resolveSnapshotId(r.symbol, r.snapshotId);
      const full = { ...r, snapshotId };
      insertScannerResult({
        id: full.id,
        symbol: full.symbol,
        timestamp: full.timestamp,
        scanner: full.strategy,
        sessionId: full.sessionId ?? null,
        snapshotId,
        decision: full.decision,
        confidence: full.confidence ?? null,
        riskScore: full.riskScore ?? null,
        schemaVersion: full.schemaVersion,
        featureVersion: full.featureVersion,
        engineVersion: full.engineVersion,
        payload: JSON.stringify(full),
        createdAt: new Date().toISOString(),
      });
      recorded.push(full.id);
    }
    return res.json({ success: true, recorded: recorded.length, ids: recorded });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

apiRouter.get("/scanner", (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  const filter: ScannerResultFilter = {
    symbol: q.symbol,
    scanner: q.scanner,
    decision: q.decision,
    sessionId: q.sessionId,
    snapshotId: q.snapshotId,
    date: q.date,
    limit: q.limit ? parseInt(q.limit, 10) : 5000,
  };
  const rows = getScannerResults(filter);
  return res.json({ success: true, count: rows.length, results: rows });
});

// Idempotent outcome resolution: the Outcome Pipeline writes the resolved
// outcome (WIN/LOSS/NO_FILL/CANCELLED/EXPIRED, exit reason, MFE/MAE,
// R-multiple, holding time) back onto an existing scanner result by id.
apiRouter.post("/scanner/outcome", (req: Request, res: Response) => {
  try {
    const { id, outcome } = req.body ?? {};
    if (!id || typeof outcome !== "object" || outcome === null) {
      return res.status(400).json({ error: "id_and_outcome_required" });
    }
    const ok = updateScannerResultOutcome(id, outcome);
    if (!ok) return res.status(404).json({ error: "not_found" });
    return res.json({ success: true, id });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});

// ── Snapshot reads (Replay / Evaluation) ───────────────────
apiRouter.get("/snapshot/:id", (req: Request, res: Response) => {
  const snap = readSnapshotById(req.params.id);
  if (!snap) return res.status(404).json({ error: "not_found" });
  return res.json(snap);
});

apiRouter.get("/snapshots", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  const date = req.query.date as string | undefined;
  if (!symbol) return res.status(400).json({ error: "symbol_required" });
  const snapshots = getSnapshotsForSymbol(symbol, date);
  return res.json({ success: true, symbol, count: snapshots.length, snapshots });
});

apiRouter.get("/snapshots/summary", (req: Request, res: Response) => {
  const symbol = req.query.symbol as string | undefined;
  const date = req.query.date as string | undefined;
  if (!symbol) return res.status(400).json({ error: "symbol_required" });
  return res.json({
    success: true,
    symbol,
    count: getSnapshotsSummary(symbol, date).length,
    snapshots: getSnapshotsSummary(symbol, date),
  });
});

apiRouter.get("/candles", (req: Request, res: Response) => {
  const { symbol, interval, date } = req.query as Record<string, string | undefined>;
  if (!symbol || !interval || !date) {
    return res.status(400).json({ error: "symbol,interval,date required" });
  }
  return res.json({
    success: true,
    candles: getSessionCandles(symbol, interval, date),
  });
});

apiRouter.get("/integrity", (req: Request, res: Response) => {
  const { symbol, date } = req.query as Record<string, string | undefined>;
  if (!symbol) return res.status(400).json({ error: "symbol_required" });
  return res.json({ success: true, rows: getSnapshotIntegrityRows(symbol, date) });
});

apiRouter.get("/version/:id", (req: Request, res: Response) => {
  const v = getSnapshotVersion(req.params.id);
  if (!v) return res.status(404).json({ error: "not_found" });
  return res.json(v);
});

apiRouter.get("/status", (_req: Request, res: Response) => {
  return res.json({
    totalSnapshots: getTotalSnapshots(),
    lastCaptureTime: getLastCaptureTime(),
    snapshotCount: getTotalSnapshots(),
    databaseSizeBytes: getDbFileSizeBytes(),
  });
});
