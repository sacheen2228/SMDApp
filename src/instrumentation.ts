// instrumentation.ts — runs once on Next.js server start
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Auto-set Telegram webhook on server start
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : process.env.RENDER_EXTERNAL_URL || null;

    if (token && baseUrl) {
      try {
        const webhookUrl = `${baseUrl}/api/telegram/webhook`;
        const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: webhookUrl }),
        });
        const data = await res.json();
        console.log(`[Telegram] Webhook auto-set: ${data.ok ? "OK" : data.description}`);
      } catch (err: any) {
        console.warn(`[Telegram] Webhook auto-set failed: ${err.message}`);
      }
    }

    // Auto-start Nous Orchestrator (24/7 background worker)
    try {
      const { startOrchestrator } = await import("@/lib/hermes/nous-orchestrator");
      await startOrchestrator();
      console.log("[Nous] Orchestrator auto-started");
    } catch (err: any) {
      console.warn("[Nous] Orchestrator auto-start failed:", err.message);
    }

    // Auto-start SDM chain scanner — keeps /api/option-chain analysis (and
    // its entry alerts + tiger TP/SL cards) running for NIFTY/SENSEX + the
    // F&O stock rotation without the dashboard open. Market-hours gated.
    try {
      const { startSdmChainScanner } = await import("@/lib/sdm-chain-scanner");
      startSdmChainScanner();
    } catch (err: any) {
      console.warn("[sdm-scan] auto-start failed:", err.message);
    }

    // Restore one-trade-per-underlying locks from DB (never called before —
    // left stale ACTIVE rows free to re-enter while blocking nothing useful)
    try {
      const { restoreLocksFromDB } = await import("@/lib/active-trade-lock");
      await restoreLocksFromDB();
      console.log("[ActiveTradeLock] Restored on boot");
    } catch (err: any) {
      console.warn(`[ActiveTradeLock] Restore failed: ${err.message}`);
    }

    // Expire stale ACTIVE/OPEN rows older than 2 trading days so one-trade-
    // per-underlying locks free up (NIFTY was stuck behind 226 dead ACTives).
    // Since the null-pnl-repair work: each expired row gets its REAL close
    // via resolveRealExit (same rules as scripts/repair-null-pnl.ts); rows
    // we can't price honestly get exitReason stale_reload_cleanup_no_data
    // instead of a bare stale_reload_cleanup with a null pnl.
    try {
      const { db } = await import("@/lib/db");
      const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const stale = await db.trade.findMany({
        where: {
          status: { in: ["ACTIVE", "OPEN", "PENDING"] },
          createdAt: { lt: cutoff },
          // Keep real today/yesterday production trades; expire junk + old
          NOT: { strategy: { in: ["e2e-test", "prod-verify"] } },
        },
        select: {
          id: true,
          tradeId: true,
          symbol: true,
          strategy: true,
          type: true,
          side: true,
          entryPrice: true,
          entryTime: true,
          strike: true,
        },
      });
      let priced = 0;
      for (const row of stale as any[]) {
        const stamp = new Date();
        let data: Record<string, unknown> = {
          status: "EXPIRED",
          exitTime: stamp,
          exitReason: "stale_reload_cleanup_no_data",
        };
        try {
          const { resolveRealExit } = await import("@/lib/null-pnl-repair");
          const res = await resolveRealExit({ ...row, exitTime: null });
          if (res.outcome === "PRICED") {
            data = {
              status: "EXPIRED",
              exitTime: new Date(`${res.exitDate}T15:20:00+05:30`),
              exitReason: "stale_reload_cleanup",
              exitPrice: res.exitPrice,
              pnl: res.pnl,
              pnlPercent: res.pnlPercent,
            };
            priced++;
          }
        } catch (e: any) {
          console.warn(`[ActiveTrade] resolve failed for ${row.tradeId}: ${e?.message || e}`);
        }
        await db.trade.update({ where: { id: row.id }, data });
      }
      if (stale.length > 0) {
        console.log(
          `[ActiveTrade] Expired ${stale.length} stale ACTIVE trades (>2 days), priced ${priced}, unpriced ${stale.length - priced}`
        );
        // Rebuild locks after cleanup
        const { restoreLocksFromDB } = await import("@/lib/active-trade-lock");
        await restoreLocksFromDB();
      }
    } catch (err: any) {
      console.warn(`[ActiveTrade] Stale cleanup failed: ${err.message}`);
    }

    // Auto-reload active trades from database (lost on restart).
    // Prisma direct read — works before HTTP server is listening.
    try {
      const { reloadActiveTrades } = await import("@/lib/activeTradeTracker");
      const loaded = await reloadActiveTrades();
      console.log(`[ActiveTrade] Reloaded ${loaded} trades from database`);
    } catch (err: any) {
      console.warn(`[ActiveTrade] Reload failed: ${err.message}`);
    }

    // Auto-start TIGER trade monitor (SL/TP/T trailing + Telegram alerts)
    try {
      const { startTigerMonitor } = await import("@/lib/tiger-monitor");
      await startTigerMonitor();
      console.log("[TIGER] Trade monitor auto-started");
    } catch (err: any) {
      console.warn(`[TIGER] Monitor auto-start failed: ${err.message}`);
    }
  }
}
