import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const PYTHON_DIR = join(process.cwd(), "python-screener");
const WRAPPER = join(PYTHON_DIR, "wrapper.py");

async function runPython(input: any): Promise<any> {
  const tmpInput = join("/tmp", `screener_${Date.now()}.json`);
  try {
    writeFileSync(tmpInput, JSON.stringify(input));
    const out = execSync(
      `python3 "${WRAPPER}" < "${tmpInput}" 2>/dev/null`,
      { timeout: 30000, env: { ...process.env } }
    );
    const text = out.toString().trim();
    if (!text) return { success: false, error: "Empty output from Python" };
    return JSON.parse(text);
  } catch (e: any) {
    const msg = e.stderr?.toString?.() || e.stdout?.toString?.() || e.message || "Python failed";
    return { success: false, error: msg };
  } finally {
    try { unlinkSync(tmpInput); } catch {}
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action") || "screen";
  const symbol = searchParams.get("symbol") || "NIFTY";
  const direction = searchParams.get("direction") || "CE";

  // Fetch data FIRST (while Node.js is handling this request)
  const chainRes = await fetch(
    `${process.env.SMDAPP_API_BASE || "http://localhost:3000"}/api/option-chain?symbol=${symbol}`,
    { signal: AbortSignal.timeout(10000) }
  ).then(r => r.json()).catch(() => ({ success: false, error: "chain fetch failed" }));

  // Pass it to Python so it doesn't self-call (avoids deadlock)
  const result = await runPython({
    action,
    symbol,
    direction,
    chain_data: chainRes,
  });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = body.symbol || "NIFTY";
    const chainRes = await fetch(
      `${process.env.SMDAPP_API_BASE || "http://localhost:3000"}/api/option-chain?symbol=${symbol}`,
      { signal: AbortSignal.timeout(10000) }
    ).then(r => r.json()).catch(() => ({ success: false, error: "chain fetch failed" }));
    const result = await runPython({ ...body, chain_data: chainRes });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
