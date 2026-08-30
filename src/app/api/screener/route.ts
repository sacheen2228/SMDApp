import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { fetchLiveOptionChain } from "@/lib/live-option-chain";

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

  const chainResult = await fetchLiveOptionChain(symbol).catch(() => ({ success: false as const, source: 'none' as const, error: 'fetch failed' }));

  const result = await runPython({
    action,
    symbol,
    direction,
    chain_data: chainResult,
  });
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const symbol = body.symbol || "NIFTY";
    const chainResult = await fetchLiveOptionChain(symbol).catch(() => ({ success: false as const, source: 'none' as const, error: 'fetch failed' }));
    const result = await runPython({ ...body, chain_data: chainResult });
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
