// ═══════════════════════════════════════════════════════════════════════════
// Kill Switch (v2 §10)
//   "Hermes, stop all trading"      → immediately blocks NEW trade
//     registrations. NO confirmation needed to stop. Existing monitoring
//     keeps running — active trades still get TP/SL alerts.
//   "CONFIRM RESUME TRADING"        → the only phrase that resumes
//     (resume requires the explicit CONFIRM form; stop never does).
// Env: TRADING_KILL_SWITCH=1 boots the system halted.
// Scope: the agent pipeline's registration path. Monitoring/alerting is
// never gated — alerts for already-registered trades must keep flowing.
// ═══════════════════════════════════════════════════════════════════════════

let halted: boolean = process.env.TRADING_KILL_SWITCH === '1';

const STOP_RE = /stop all trading/i;
const RESUME_RE = /CONFIRM RESUME TRADING/i;

export function isTradingHalted(): boolean {
  return halted;
}

/** Test/ops helper — sets state directly. */
export function setTradingHalted(value: boolean): void {
  const was = halted;
  halted = value;
  if (was !== value) {
    console.warn(
      value
        ? '[KillSwitch] TRADING HALTED — new registrations blocked; monitoring continues'
        : '[KillSwitch] trading resumed — registrations allowed'
    );
  }
}

/**
 * Detect the kill-switch phrases in a chat message.
 * Returns 'stopped' | 'resumed' | null.
 * Stop: any message containing "stop all trading" (no confirmation).
 * Resume: ONLY the exact CONFIRM phrase (case-insensitive).
 */
export function maybeHandleKillSwitch(message: string): 'stopped' | 'resumed' | null {
  const m = String(message || '').trim();
  if (STOP_RE.test(m)) {
    if (!halted) setTradingHalted(true);
    return 'stopped';
  }
  if (RESUME_RE.test(m)) {
    if (halted) setTradingHalted(false);
    return 'resumed';
  }
  return null;
}

export function killSwitchMessage(result: 'stopped' | 'resumed'): string {
  return result === 'stopped'
    ? 'TRADING HALTED. New trade registrations are blocked immediately. Live monitoring and TP/SL alerts continue for existing trades. Say CONFIRM RESUME TRADING to resume.'
    : 'Trading resumed. New trade registrations are allowed again.';
}
