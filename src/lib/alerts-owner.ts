// Single ownership switch for every outbound trade alert and in-process
// alert scanner. Exactly one process/deploy may set ALERTS_OWNER=true.
//
// Local systemd cron: ALERTS_OWNER=true in the Next.js process env.
// Render/webhook deploy: ALERTS_OWNER=false (or unset) unless it is the owner.
// Tests: set ALERTS_OWNER=true explicitly when a test expects a send.
export function isAlertsOwner(): boolean {
  return process.env.ALERTS_OWNER === "true";
}

/** Log once per call site when a non-owner tries to send. */
export function suppressIfNotOwner(scope: string): boolean {
  if (isAlertsOwner()) return false;
  console.log(`[alerts-owner] ${scope} suppressed — ALERTS_OWNER is not "true"`);
  return true;
}
