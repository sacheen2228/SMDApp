import { NextResponse } from 'next/server';
import { runInstitutionalPositioning, generateAIMarketSummary } from '@/lib/institutional-positioning-engine';

export async function GET() {
  try {
    const data = await runInstitutionalPositioning();
    const summary = generateAIMarketSummary(data);
    return NextResponse.json({
      success: true,
      ...data,
      aiSummary: summary,
      warning: data.source === 'none' ? 'No participant OI data available. Analysis based on empty positions — results are not actionable.' : undefined,
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message || 'Failed' },
      { status: 500 }
    );
  }
}
