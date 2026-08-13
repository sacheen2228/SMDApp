import { NextResponse } from 'next/server';
import { runInstitutionalPositioning } from '@/lib/institutional-positioning-engine';

export async function GET() {
  try {
    const data = await runInstitutionalPositioning();
    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed to fetch participant OI' },
      { status: 500 }
    );
  }
}
