// ═══════════════════════════════════════════════════════════════════════════
// PLAYBOOK_CHECK — the option-buying playbook's 8-item pre-trade checklist
// as a deterministic post-engine gate (Phase 4.5).
//
// Dedup contract: this module does NOT re-score factors (cross-confluence owns
// aggregation; the 30 agents own their factors) and does NOT re-implement
// strike math (greeks/sizing own that). It only ANDs existing agent evidence
// + the engine candidate against the checklist. Any "no" = skip the trade.
// Thresholds: playbook rules — option R:R >= 1:2, risk <= 1% of capital.
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentResearchOutput } from './agent-contract';
import type { TradeCandidate } from '../trade-validator-gate';
import { getLotSize } from '../challenge/capital-manager';

export interface PlaybookItemResult {
  item: number;
  label: string;
  pass: boolean;
  note: string;
}

export interface PlaybookCheckResult {
  checked: boolean;
  pass: boolean;
  failedItems: number[];
  items: PlaybookItemResult[];
}

export interface PlaybookCheckEnv {
  participantOI?: {
    client?: { indexLong?: number; indexShort?: number };
  };
  capital?: number;
}

export const PLAYBOOK_MAX_RISK_PCT = 1;
const PLAYBOOK_MIN_RR = 2;
const CROWD_THRESHOLD = 65;
const OPPOSE_MIN_CONF = 60;
const DEFAULT_CAPITAL = 100000;

export const PLAYBOOK_ITEM_LABELS: Record<number, string> = {
  1: 'Flow aligned',
  2: 'Positioning not crowded',
  3: 'HTF structure agrees',
  4: 'Level with OI support',
  5: 'Candle confirmation',
  6: 'Strike selector passes',
  7: 'Stop/RR/risk limits',
  8: 'No event or expiry distortion',
};

function isShortDirection(direction: string): boolean {
  return /BUY_PE|SELL|SHORT/.test(direction || '');
}

function agentOpposes(a: AgentResearchOutput | undefined, short: boolean): boolean {
  if (!a) return false;
  if (a.bias !== 'BULLISH' && a.bias !== 'BEARISH') return false;
  if (a.confidence < OPPOSE_MIN_CONF) return false;
  return short ? a.bias === 'BULLISH' : a.bias === 'BEARISH';
}

function byId(outputs: AgentResearchOutput[], id: string): AgentResearchOutput | undefined {
  return outputs.find(o => o.agentId === id);
}

function agentNote(id: string, a: AgentResearchOutput | undefined, opposed: boolean): string {
  if (!a || a.bias === 'NO_DATA' || a.confidence === 0) {
    return `${id.replace(/_/g, '/')} no data — cannot verify (not a veto)`;
  }
  if (opposed) return `${id.replace(/_/g, '/')} ${a.bias} (conf ${a.confidence}) opposes direction`;
  if (a.bias === 'NEUTRAL') return `${id.replace(/_/g, '/')} neutral (conf ${a.confidence}) — not against`;
  return `${id.replace(/_/g, '/')} ${a.bias} (conf ${a.confidence}) — not against`;
}

function checkOpposition(
  item: number,
  outputs: AgentResearchOutput[],
  ids: string[],
  short: boolean,
): PlaybookItemResult {
  const notes: string[] = [];
  let pass = true;
  for (const id of ids) {
    const a = byId(outputs, id);
    const opposed = agentOpposes(a, short);
    if (opposed) pass = false;
    notes.push(agentNote(id, a, opposed));
  }
  return { item, label: PLAYBOOK_ITEM_LABELS[item], pass, note: notes.join('; ') };
}

export function evaluatePlaybookCheck(
  candidate: TradeCandidate | undefined,
  agentOutputs: AgentResearchOutput[],
  env: PlaybookCheckEnv = {},
): PlaybookCheckResult {
  if (!candidate) {
    return { checked: false, pass: true, failedItems: [], items: [] };
  }

  const capital = env.capital ?? DEFAULT_CAPITAL;
  const short = isShortDirection(candidate.direction);
  const items: PlaybookItemResult[] = [];

  // 1. Flow bias (FII futures trend + FII/DII cash) aligned?
  items.push(checkOpposition(1, agentOutputs, ['FII_DII'], short));

  // 2. Client/Pro positioning not crowded against me?
  const poi = env.participantOI;
  const client = poi?.client;
  if (client && typeof client.indexLong === 'number' && typeof client.indexShort === 'number') {
    const crowdedLong = client.indexLong >= CROWD_THRESHOLD;
    const crowdedShort = client.indexShort >= CROWD_THRESHOLD;
    const against = short ? crowdedShort : crowdedLong;
    items.push({
      item: 2, label: PLAYBOOK_ITEM_LABELS[2], pass: !against,
      note: against
        ? `Client index ${short ? 'short' : 'long'} ${short ? client.indexShort : client.indexLong}% ≥ ${CROWD_THRESHOLD}% — crowded against`
        : `Client long ${client.indexLong}% / short ${client.indexShort}% — not crowded (≥${CROWD_THRESHOLD}% would fail)`,
    });
  } else {
    items.push({
      item: 2, label: PLAYBOOK_ITEM_LABELS[2], pass: true,
      note: 'Participant OI unavailable — crowding not verified (not a veto)',
    });
  }

  // 3. Higher-timeframe structure agrees?
  items.push(checkOpposition(3, agentOutputs, ['MTF_CONFIRMATION', 'MARKET_STRUCTURE'], short));

  // 4. Price at a level with OI support (writing or unwinding)?
  items.push(checkOpposition(4, agentOutputs, ['SUPPORT_RESISTANCE', 'OI_CLASSIFICATION'], short));

  // 5. Candle confirmation present?
  items.push(checkOpposition(5, agentOutputs, ['BREAKOUT', 'MOMENTUM'], short));

  // 6. Strike selector passes: option R:R >= 1:2 and lots >= 1 at the 1% budget.
  const entry = candidate.entry;
  const sl = candidate.stopLoss;
  const tp1 = candidate.target1;
  const perUnitRisk = entry - sl;
  const rr = perUnitRisk > 0 && tp1 > entry ? (tp1 - entry) / perUnitRisk : 0;
  const lotSize = candidate.lotSize || getLotSize(candidate.symbol);
  const riskPerLot = perUnitRisk * lotSize;
  const budget = capital * (PLAYBOOK_MAX_RISK_PCT / 100);
  const lots = riskPerLot > 0 ? Math.floor(budget / riskPerLot) : 0;
  const i6notes: string[] = [];
  let i6pass = true;
  if (rr < PLAYBOOK_MIN_RR) {
    i6pass = false;
    i6notes.push(`option R:R ${rr.toFixed(2)} < ${PLAYBOOK_MIN_RR} (need 1:2)`);
  } else {
    i6notes.push(`option R:R ${rr.toFixed(2)} ≥ ${PLAYBOOK_MIN_RR}`);
  }
  if (lots < 1) {
    i6pass = false;
    i6notes.push(`${lotSize}-unit lot risk ₹${riskPerLot} > ${PLAYBOOK_MAX_RISK_PCT}% budget ₹${budget} — lots ${lots} < 1`);
  } else {
    i6notes.push(`${lots} lot(s) within ${PLAYBOOK_MAX_RISK_PCT}% budget (lot ${lotSize})`);
  }
  i6notes.push('theta cost not verified (no theta input)');
  items.push({ item: 6, label: PLAYBOOK_ITEM_LABELS[6], pass: i6pass, note: i6notes.join('; ') });

  // 7. Stop / reward:risk / risk% limits.
  const i7notes: string[] = [];
  let i7pass = true;
  if (rr < PLAYBOOK_MIN_RR) {
    i7pass = false;
    i7notes.push(`R:R ${rr.toFixed(2)} < ${PLAYBOOK_MIN_RR}`);
  } else {
    i7notes.push(`R:R ${rr.toFixed(2)} ≥ ${PLAYBOOK_MIN_RR}`);
  }
  if (candidate.maxLoss != null) {
    const cap = capital * (PLAYBOOK_MAX_RISK_PCT / 100);
    if (candidate.maxLoss > cap) {
      i7pass = false;
      i7notes.push(`maxLoss ₹${candidate.maxLoss} > ${PLAYBOOK_MAX_RISK_PCT}% of ₹${capital} (₹${cap})`);
    } else {
      i7notes.push(`maxLoss ₹${candidate.maxLoss} ≤ ${PLAYBOOK_MAX_RISK_PCT}% of ₹${capital}`);
    }
  } else {
    i7notes.push(`maxLoss unknown — risk % unchecked (item 6 already enforces lot feasibility; capital default ₹${capital})`);
  }
  if (candidate.instrument === 'CALL' || candidate.instrument === 'PUT') {
    i7notes.push('stop is premium-based (underlying stop not in candidate)');
  }
  items.push({ item: 7, label: PLAYBOOK_ITEM_LABELS[7], pass: i7pass, note: i7notes.join('; ') });

  // 8. No major event or expiry distortion nearby?
  const ev = byId(agentOutputs, 'EVENT_RISK');
  const flags = ev?.riskFlags ?? [];
  items.push({
    item: 8, label: PLAYBOOK_ITEM_LABELS[8], pass: flags.length === 0,
    note: flags.length > 0 ? flags.join('; ') : 'No event/expiry flags',
  });

  const failedItems = items.filter(i => !i.pass).map(i => i.item);
  return { checked: true, pass: failedItems.length === 0, failedItems, items };
}

/** Engine-shaped NO_TRADE when the checklist has a "no". */
export function playbookNoTrade(check: PlaybookCheckResult) {
  const labels = check.failedItems
    .map(n => `${PLAYBOOK_ITEM_LABELS[n]} (item ${n})`)
    .join(', ');
  return {
    action: 'NO_TRADE' as const,
    reasons: [`Playbook checklist failed — no on: ${labels}`],
    risks: ['Playbook checklist: any "no" = skip the trade'],
    confidence: 0,
    grade: 'F',
  };
}
