import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { runTradeAudit } from "@/lib/backtest-audit";

const PYTHON_DIR = join(process.cwd(), "python-screener");
const ANALYZER = join(PYTHON_DIR, "backtest_analyzer.py");

function runPython(args: string[], input?: string): any {
  const cmd = `python3 "${ANALYZER}" ${args.join(" ")}`;
  try {
    const out = execSync(cmd, {
      timeout: 30000,
      input,
      env: { ...process.env },
    });
    const text = out.toString().trim();
    if (!text) return { success: false, error: "Empty output" };
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) return { success: false, error: "No JSON in output: " + text.slice(0, 300) };
    return JSON.parse(text.slice(jsonStart));
  } catch (e: any) {
    const msg = e.stderr?.toString?.() || e.stdout?.toString?.() || e.message || "Backtest failed";
    return { success: false, error: msg };
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") || "json";
  const sl = searchParams.get("sl") || "20";
  const rr = searchParams.get("rr") || "3";
  const tf = searchParams.get("tf") || "15m";

  const args = ["--demo", "--sl", sl, "--rr", rr, "--json-out"];
  const result = runPython(args);

  if (format === "html") {
    const htmlArgs = ["--demo", "--sl", sl, "--rr", rr, "--html", "/tmp/bt_report.html"];
    execSync(`python3 "${ANALYZER}" ${htmlArgs.join(" ")}`, { timeout: 30000 });
    const html = readFileSync("/tmp/bt_report.html", "utf-8");
    return new NextResponse(html, { headers: { "Content-Type": "text/html" } });
  }

  if (format === "csv") {
    const csvArgs = ["--demo", "--sl", sl, "--rr", rr, "-o", "/tmp/bt_report.csv"];
    execSync(`python3 "${ANALYZER}" ${csvArgs.join(" ")}`, { timeout: 30000 });
    const csv = readFileSync("/tmp/bt_report.csv", "utf-8");
    return new NextResponse(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=backtest_report.csv" } });
  }

  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const csvData = body.csv || "";
    const sl = body.sl || 20;
    const rr = body.rr || 3;
    const tf = body.tf || "15m";
    const format = body.format || "json";
    const isLive = body.live === true || body.dataSource === "live";
    const source = body.source || "Trade Database";

    const hasRows = csvData.trim().split("\n").length > 1;
    const auditDate = body.date || new Date().toISOString().split("T")[0];
    const auditSymbol = body.symbol || "ALL";

    let result: any;

    if (isLive) {
      // LIVE mode: REAL-DATA AUDIT (reads DB by date + real candles).
      // Runs regardless of CSV content — the engine uses the DB, not the CSV.
      try {
        result = await runTradeAudit({
          symbol: auditSymbol,
          date: auditDate,
          sourceLabel: source,
        });
      } catch (auditErr: any) {
        console.error("[BacktestAnalyzer] Live audit failed, falling back to demo:", auditErr.message);
        const args = ["--demo", "--sl", String(sl), "--rr", String(rr), "--json-out", "--source", "Audit failed, using demo"];
        result = runPython(args);
      }
    } else if (!hasRows) {
      // No data and not live → demo fallback
      const args = ["--demo", "--sl", String(sl), "--rr", String(rr), "--json-out", "--source", "No live data (fallback)"];
      result = runPython(args);
    } else {
      // DEMO mode with user data (simulate SL/TP)
      const tmpCsv = `/tmp/bt_input_${Date.now()}.csv`;
      writeFileSync(tmpCsv, csvData);
      const args = ["-i", tmpCsv, "--sl", String(sl), "--rr", String(rr), "--json-out", "--source", source];
      result = runPython(args);
      try { unlinkSync(tmpCsv); } catch {}
    }

    if (format === "csv" && hasRows && !isLive) {
      const tmpCsv = `/tmp/bt_input_${Date.now()}.csv`;
      writeFileSync(tmpCsv, csvData);
      const csvArgs = ["-i", tmpCsv, "--sl", String(sl), "--rr", String(rr), "-o", `/tmp/bt_result_${Date.now()}.csv`];
      execSync(`python3 "${ANALYZER}" ${csvArgs.join(" ")}`, { timeout: 30000 });
      const csv = readFileSync(`/tmp/bt_result_${Date.now()}.csv`, "utf-8");
      try { unlinkSync(tmpCsv); } catch {}
      return new NextResponse(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=backtest_report.csv" } });
    }

    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
