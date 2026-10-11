// ═══════════════════════════════════════════════════════════════════════════
// Premarket Readiness — the pre-flight check that answers ONE question:
// is this stack fit to trade right now?
//
// It aggregates the four inputs that previously had to be inspected one at a
// time into a single deterministic verdict:
//   1. feed gate   — live option data service reachable + all_live
//   2. data health — can we actually fetch a usable option chain (score)
//   3. session health — breeze/mo/nse sessions alive (no SESSION_EXPIRED)
//   4. morning intelligence — today's brief exists and is fresh
// plus provider circuit states and Telegram config.
//
// Verdict ladder (FAIL always outranks WARN):
//   NON_TRADING_DAY > NOT_READY > DEGRADED > READY
//   ready === true  ⇔  no check returned FAIL
//
// Wire it into the 09:10 IST cron (see /api/premarket-readiness) so the day
// starts with a known-good or known-bad stack instead of a silent failure.
// ═══════════════════════════════════════════════════════════════════════════

import { evaluateDataHealth } from '@/lib/data-health';
import {
  getISTDate,
  isHoliday,
  isTradingDay,
  getTradingSession,
  type TradingSessionLabel,
} from '@/lib/expiry-liquidity/market-session-config';

// ── Types ──────────────────────────────────────────────────────────────

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export type ReadinessGate =
  | 'READY'
  | 'DEGRADED'
  | 'NOT_READY'
  | 'NON_TRADING_DAY';

export interface PremarketReadinessReport {
  gate: ReadinessGate;
  /** true ⇔ no check FAILed (a DEGRADED stack is still tradeable) */
  ready: boolean;
  checkedAt: string;
  tradingDay: boolean;
  phase: TradingSessionLabel;
  minutesToOpen: number;
  checks: ReadinessCheck[];
  blockers: string[];
  warnings: string[];
  summary: string;
}

// ── Injected probes (defaults hit the network; tests inject doubles) ────

export interface FeedProbeResult {
  reachable: boolean;
  overall?: string;
  allLive: boolean;
  latencyMs: number;
  failNote?: string;
}

export interface ChainProbeResult {
  ok: boolean;
  source?: string;
  strikes?: number;
  greeks?: boolean;
  latencyMs?: number;
  /** age of the provider's own data, ms — 0/absent means "just collected" */
  ageMs?: number;
  detail?: string;
}

export interface SessionReportResult {
  probes?: Record<string, { live: boolean; detail?: string } | undefined>;
  summary?: { anySessionExpired?: boolean; expiredSources?: string[] };
}

export interface PremarketReadinessDeps {
  now?: Date;
  feedProbe?: () => Promise<FeedProbeResult>;
  chainProbe?: () => Promise<ChainProbeResult>;
  sessionReport?: () => Promise<SessionReportResult>;
  brief?: () => { timestamp?: string } | null | Promise<{ timestamp?: string } | null>;
  providerCircuits?: () => { open: string[] } | Promise<{ open: string[] }>;
  telegramConfigured?: () => boolean;
}

const OPEN_MINUTES = 9 * 60 + 15; // 09:15 IST

const PHASE_LABEL: Record<TradingSessionLabel, string> = {
  PRE_OPEN: 'Pre-Market',
  OPEN: 'Opening',
  REGULAR: 'Regular Session',
  POST_MARKET: 'Post-Market',
  CLOSED: 'Closed',
};

function istMinutes(d: Date): number {
  const ist = getISTDate(d);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Same IST calendar day (exchange holidays are Indian dates). */
function isSameISTDay(a: Date, b: Date): boolean {
  return getISTDate(a).toISOString().slice(0, 10) === getISTDate(b).toISOString().slice(0, 10);
}

// ── Default probes (network) ───────────────────────────────────────────

async function defaultFeedProbe(): Promise<FeedProbeResult> {
  const { probeLiveDataService } = await import('@/lib/agents/feed-gate');
  return probeLiveDataService();
}

async function defaultChainProbe(): Promise<ChainProbeResult> {
  const t0 = Date.now();
  const { getOptionChain } = await import('@/lib/data-layer/chains/option-chain');
  const res = await getOptionChain('NIFTY');
  if (!res.data) {
    return { ok: false, latencyMs: Date.now() - t0, detail: res.fallbackReason || 'no option chain' };
  }
  const strikes = res.data.strikes?.length ?? 0;
  const atm = res.data.spot != null
    ? res.data.strikes.find((s) => Math.abs(s.strike - (res.data!.spot as number)) <= 50)
    : undefined;
  const greeks = !!(atm?.ce?.delta != null || atm?.pe?.delta != null);
  return {
    ok: strikes > 0,
    source: res.data.source,
    strikes,
    greeks,
    latencyMs: Date.now() - t0,
    ageMs: res.data.timestamp ? Math.max(0, Date.now() - new Date(res.data.timestamp).getTime()) : 0,
  };
}

async function defaultSessionReport(): Promise<SessionReportResult> {
  const { buildSessionStatusReport } = await import('@/lib/session-health');
  const raw = await buildSessionStatusReport('all');
  return raw as unknown as SessionReportResult;
}

async function defaultBrief(): Promise<{ timestamp?: string } | null> {
  try {
    const { getLastMorningBrief } = await import('@/lib/hermes/morning-intelligence');
    return getLastMorningBrief();
  } catch {
    return null;
  }
}

async function defaultProviderCircuits(): Promise<{ open: string[] }> {
  try {
    const { providerHealth } = await import('@/lib/provider-health');
    const open: string[] = [];
    for (const [name, h] of Object.entries(providerHealth.getAllHealth())) {
      if (h.circuitState === 'OPEN' || h.status === 'balance_exhausted') open.push(name);
    }
    return { open };
  } catch {
    return { open: [] };
  }
}

function defaultTelegramConfigured(): boolean {
  return (process.env.TELEGRAM_DIGEST_CHAT_IDS ?? '').split(',').some((s) => s.trim().length > 0);
}

// ── Evaluation ─────────────────────────────────────────────────────────

export async function evaluatePremarketReadiness(
  deps: PremarketReadinessDeps = {},
): Promise<PremarketReadinessReport> {
  const now = deps.now ?? new Date();
  const tradingDay = isTradingDay(now);
  const phase = getTradingSession(now);
  const minutes = istMinutes(now);
  const minutesToOpen = minutes < OPEN_MINUTES ? OPEN_MINUTES - minutes : 0;

  const checks: ReadinessCheck[] = [];

  // 1. trading day — always evaluated
  checks.push(
    tradingDay
      ? { id: 'trading_day', label: 'Trading day', status: 'PASS', detail: `${PHASE_LABEL[phase]} — weekday with no exchange holiday` }
      : {
          id: 'trading_day',
          label: 'Trading day',
          status: 'FAIL',
          detail: isHoliday(now)
            ? `Exchange holiday on ${getISTDate(now).toISOString().slice(0, 10)}`
            : `Weekend — ${getISTDate(now).toISOString().slice(0, 10)}`,
          remediation: 'No trading today; re-arm the cron for the next trading day',
        },
  );

  if (!tradingDay) {
    // Dependent checks are SKIP — never reported as PASS when not run.
    const skipped: Array<[string, string]> = [
      ['session_clock', 'Session clock'],
      ['feed_gate', 'Live feed gate'],
      ['data_health', 'Option chain data health'],
      ['session_health', 'Broker session health'],
      ['provider_circuits', 'Provider circuits'],
      ['morning_brief', 'Morning brief'],
      ['telegram', 'Telegram delivery'],
    ];
    for (const [id, label] of skipped) {
      checks.push({ id, label, status: 'SKIP', detail: 'Not evaluated — non-trading day' });
    }
    return finish(checks, 'NON_TRADING_DAY', false, now, phase, minutesToOpen);
  }

  // 2. session clock
  checks.push({
    id: 'session_clock',
    label: 'Session clock',
    status: 'PASS',
    detail: minutesToOpen > 0
      ? `${PHASE_LABEL[phase]} — ${minutesToOpen} min to 09:15 IST open`
      : `${PHASE_LABEL[phase]} — market window at or past 09:15 IST`,
  });

  // 3. feed gate
  checks.push(await runCheck('feed_gate', 'Live feed gate', async () => {
    const probe = await (deps.feedProbe ?? defaultFeedProbe)();
    if (probe.reachable && probe.allLive) {
      return { status: 'PASS', detail: `Live service ${probe.overall ?? 'ok'} (all_live=true, ${probe.latencyMs}ms)` };
    }
    return {
      status: 'FAIL',
      detail: probe.reachable
        ? `Live service all_live=false (overall=${probe.overall ?? 'unknown'})`
        : `Live service unreachable — ${probe.failNote ?? 'no response'} (service not running?)`,
      remediation: 'Start live-data-service (port 8765) before the open',
    };
  }));

  // 4. data health — real option chain, scored by data-health
  checks.push(await runCheck('data_health', 'Option chain data health', async () => {
    const probe = await (deps.chainProbe ?? defaultChainProbe)();
    if (!probe.ok) {
      return {
        status: 'FAIL',
        detail: `Option chain unavailable — ${probe.detail ?? 'no data'} (${probe.latencyMs ?? 0}ms)`,
        remediation: 'Check NSE/BSE connectivity or apply a fresh Breeze session',
      };
    }
    const health = evaluateDataHealth({
      latencyMs: probe.latencyMs ?? 0,
      lastUpdateMs: Date.now() - Math.max(0, probe.ageMs ?? 0),
      totalStrikes: probe.strikes ?? 0,
      strikesWithMissingData: probe.greeks === false ? (probe.strikes ?? 0) : 0,
      atmHasGreeks: probe.greeks === true,
      source: probe.source ?? 'unknown',
    });
    if (health.status === 'CRITICAL' || health.status === 'OFFLINE') {
      return { status: 'FAIL', detail: `${health.status} (score ${health.score}) — ${health.issues.join('; ')}`, remediation: 'Fix the data source before taking signals' };
    }
    if (health.status === 'DEGRADED') {
      return { status: 'WARN', detail: `${health.status} (score ${health.score}) — ${health.issues.join('; ')}` };
    }
    return { status: 'PASS', detail: `HEALTHY (score ${health.score}) — ${probe.strikes} strikes from ${probe.source}, ${probe.latencyMs}ms` };
  }));

  // 5. session health — breeze / mo / nse
  checks.push(await runCheck('session_health', 'Broker session health', async () => {
    const report = await (deps.sessionReport ?? defaultSessionReport)();
    const expired = report.summary?.expiredSources ?? [];
    if (report.summary?.anySessionExpired || expired.length > 0) {
      return {
        status: 'FAIL',
        detail: `SESSION_EXPIRED: ${expired.join(', ') || 'unknown source'}`,
        remediation: 'Re-authenticate the expired source (see session-health remedies)',
      };
    }
    const probes = report.probes ?? {};
    const down = Object.entries(probes)
      .filter(([, p]) => p && p.live === false)
      .map(([name, p]) => `${name} (${p?.detail ?? 'unreachable'})`);
    if (down.length > 0) {
      return { status: 'FAIL', detail: `Source(s) down: ${down.join('; ')}`, remediation: 'Fix source connectivity before the open' };
    }
    const names = Object.keys(probes);
    return { status: 'PASS', detail: names.length ? `${names.length} source(s) live: ${names.join(', ')}` : 'No session failures recorded' };
  }));

  // 6. provider circuits
  checks.push(await runCheck('provider_circuits', 'Provider circuits', async () => {
    const { open } = await (deps.providerCircuits ?? defaultProviderCircuits)();
    if (open.length > 0) {
      return { status: 'WARN', detail: `Circuit OPEN: ${open.join(', ')} — those providers are cooling down` };
    }
    return { status: 'PASS', detail: 'All provider circuits CLOSED' };
  }));

  // 7. morning brief — today's, not yesterday's
  checks.push(await runCheck('morning_brief', 'Morning brief', async () => {
    const brief = await (deps.brief ?? defaultBrief)();
    if (!brief) {
      return { status: 'WARN', detail: 'No morning brief generated yet' };
    }
    const ts = brief.timestamp ? new Date(brief.timestamp) : null;
    if (!ts || isNaN(ts.getTime())) {
      return { status: 'WARN', detail: 'Morning brief has no usable timestamp' };
    }
    if (!isSameISTDay(ts, now)) {
      return { status: 'WARN', detail: `Morning brief is from ${getISTDate(ts).toISOString().slice(0, 10)} — stale` };
    }
    return { status: 'PASS', detail: `Brief from ${ts.toISOString()}` };
  }));

  // 8. telegram delivery
  checks.push(await runCheck('telegram', 'Telegram delivery', async () => {
    const configured = (deps.telegramConfigured ?? defaultTelegramConfigured)();
    if (!configured) {
      return { status: 'WARN', detail: 'TELEGRAM_DIGEST_CHAT_IDS not configured — signals cannot be delivered' };
    }
    return { status: 'PASS', detail: 'Digest chat IDs configured' };
  }));

  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const gate: ReadinessGate = hasFail ? 'NOT_READY' : hasWarn ? 'DEGRADED' : 'READY';
  return finish(checks, gate, !hasFail, now, phase, minutesToOpen);
}

/** Wrap a probe so a throw becomes an honest FAIL, never a crash or a PASS. */
async function runCheck(
  id: string,
  label: string,
  fn: () => Promise<{ status: CheckStatus; detail: string; remediation?: string }>,
): Promise<ReadinessCheck> {
  try {
    const r = await fn();
    return { id, label, status: r.status, detail: r.detail, remediation: r.remediation };
  } catch (e) {
    return { id, label, status: 'FAIL', detail: `Check threw: ${errText(e)}` };
  }
}

function finish(
  checks: ReadinessCheck[],
  gate: ReadinessGate,
  ready: boolean,
  now: Date,
  phase: TradingSessionLabel,
  minutesToOpen: number,
): PremarketReadinessReport {
  const blockers = checks.filter((c) => c.status === 'FAIL').map((c) => `${c.id}: ${c.detail}`);
  const warnings = checks.filter((c) => c.status === 'WARN').map((c) => `${c.id}: ${c.detail}`);

  const summary =
    gate === 'READY'
      ? `READY — all ${checks.length} checks passed`
      : gate === 'DEGRADED'
        ? `DEGRADED — ready with ${warnings.length} warning(s)`
        : gate === 'NOT_READY'
          ? `NOT_READY — ${blockers.length} blocker(s), ${warnings.length} warning(s)`
          : `NON_TRADING_DAY — ${blockers[0] ?? 'not a trading day'}`;

  return {
    gate,
    ready,
    checkedAt: now.toISOString(),
    tradingDay: gate !== 'NON_TRADING_DAY',
    phase,
    minutesToOpen,
    checks,
    blockers,
    warnings,
    summary,
  };
}

// ── Rendering ──────────────────────────────────────────────────────────

export function formatReadinessMessage(r: PremarketReadinessReport): string {
  const lines: string[] = [];
  lines.push(`PRE-MARKET READINESS: ${r.gate}`);
  lines.push(`Checked ${r.checkedAt} IST-window | ${r.phase} | ${r.minutesToOpen} min to open`);
  lines.push('');

  for (const c of r.checks) {
    const rem = c.remediation ? ` → ${c.remediation}` : '';
    lines.push(`[${c.status}] ${c.id} — ${c.detail}${rem}`);
  }

  if (r.blockers.length) {
    lines.push('');
    lines.push('BLOCKERS:');
    for (const b of r.blockers) lines.push(`  • ${b}`);
  }
  if (r.warnings.length) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of r.warnings) lines.push(`  • ${w}`);
  }

  lines.push('');
  lines.push(r.summary);
  return lines.join('\n');
}
