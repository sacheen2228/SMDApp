// ═══════════════════════════════════════════════════════════════════════════
// GET /api/events/stream — Server-Sent Events for real-time agent events
// ═══════════════════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server';
import { getEvents, isFeatureEnabled } from '@/lib/agents/registry';

export async function GET(req: NextRequest) {
  if (!isFeatureEnabled('AGENT_WEBSOCKET_ENABLED')) {
    return new Response(JSON.stringify({ error: 'Events disabled' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { searchParams } = new URL(req.url);
  const since = searchParams.get('since');
  const limit = parseInt(searchParams.get('limit') || '100');

  // SSE endpoint
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      // Send initial events
      const events = getEvents({ since: since || undefined, limit });
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
        );
      }

      // Heartbeat every 30s
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30000);

      // Close on client disconnect
      req.signal.addEventListener('abort', () => {
        clearInterval(heartbeat);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
