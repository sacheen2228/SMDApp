// NSE OI Spurts API — GET endpoint
import { NextResponse } from "next/server";
import { fetchOISpurts } from "@/lib/nse-oi-spurts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await fetchOISpurts();
    return NextResponse.json({ success: true, data: result });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
