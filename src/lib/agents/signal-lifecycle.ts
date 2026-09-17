// ═══════════════════════════════════════════════════════════════════════════
// Signal Lifecycle — RESEARCH → CANDIDATE → VALIDATING → FINAL → ACTIVE → CLOSED
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentSignal, SignalLifecycle } from './types';
import { getSignal, validateSignal, emitEvent } from './registry';

export interface LifecycleTransition {
  from: SignalLifecycle;
  to: SignalLifecycle;
  description: string;
  requiresValidation: boolean;
}

export const VALID_TRANSITIONS: LifecycleTransition[] = [
  { from: 'RESEARCH', to: 'CANDIDATE', description: 'Research complete, candidate identified', requiresValidation: false },
  { from: 'CANDIDATE', to: 'VALIDATING', description: 'Sent to validation', requiresValidation: false },
  { from: 'VALIDATING', to: 'VALIDATED', description: 'Passed validation', requiresValidation: true },
  { from: 'VALIDATING', to: 'REJECTED', description: 'Failed validation', requiresValidation: true },
  { from: 'CANDIDATE', to: 'REJECTED', description: 'Rejected during research', requiresValidation: false },
  { from: 'VALIDATED', to: 'FINAL', description: 'Signal finalized', requiresValidation: false },
  { from: 'FINAL', to: 'ACTIVE', description: 'Trade entered', requiresValidation: false },
  { from: 'ACTIVE', to: 'TP1', description: 'Target 1 hit', requiresValidation: false },
  { from: 'ACTIVE', to: 'TP2', description: 'Target 2 hit', requiresValidation: false },
  { from: 'ACTIVE', to: 'EXIT', description: 'Signal exit', requiresValidation: false },
  { from: 'ACTIVE', to: 'SL', description: 'Stop loss hit', requiresValidation: false },
  { from: 'TP1', to: 'TP2', description: 'Target 2 hit after T1', requiresValidation: false },
  { from: 'TP1', to: 'EXIT', description: 'Exit after T1', requiresValidation: false },
  { from: 'TP1', to: 'SL', description: 'Stop loss after T1', requiresValidation: false },
  { from: 'TP2', to: 'EXIT', description: 'Exit after T2', requiresValidation: false },
  { from: 'TP2', to: 'SL', description: 'Stop loss after T2', requiresValidation: false },
  { from: 'FINAL', to: 'REJECTED', description: 'Rejected before execution', requiresValidation: false },
  { from: 'FINAL', to: 'CLOSED', description: 'Closed without execution', requiresValidation: false },
  { from: 'ACTIVE', to: 'CLOSED', description: 'Trade closed', requiresValidation: false },
  { from: 'EXIT', to: 'POST_TRADE_REVIEW', description: 'Post-trade review', requiresValidation: false },
  { from: 'SL', to: 'POST_TRADE_REVIEW', description: 'Post-trade review after SL', requiresValidation: false },
  { from: 'TP2', to: 'POST_TRADE_REVIEW', description: 'Post-trade review after T2', requiresValidation: false },
  { from: 'CLOSED', to: 'POST_TRADE_REVIEW', description: 'Post-trade review', requiresValidation: false },
];

export function canTransition(from: SignalLifecycle, to: SignalLifecycle): boolean {
  return VALID_TRANSITIONS.some(t => t.from === from && t.to === to);
}

export function transitionSignal(
  signalId: string,
  newLifecycle: SignalLifecycle
): { ok: boolean; error?: string; signal?: AgentSignal } {
  const signal = getSignal(signalId);
  if (!signal) {
    return { ok: false, error: `Signal ${signalId} not found` };
  }

  if (!canTransition(signal.lifecycle, newLifecycle)) {
    return {
      ok: false,
      error: `Invalid transition: ${signal.lifecycle} → ${newLifecycle}`,
    };
  }

  signal.lifecycle = newLifecycle;
  signal.updatedAt = new Date().toISOString();

  // Update timestamps
  if (newLifecycle === 'ACTIVE') {
    signal.executionStatus = 'EXECUTED';
    signal.executedAt = new Date().toISOString();
  }
  if (['TP1', 'TP2', 'EXIT', 'SL', 'CLOSED'].includes(newLifecycle)) {
    signal.executionStatus = 'NONE'; // Terminal states
  }

  emitEvent(`SIGNAL_${newLifecycle}` as any, signal.agentId, {
    signalId: signal.id,
    lifecycle: newLifecycle,
  });

  return { ok: true, signal };
}

export function getSignalLifecycle(signalId: string): {
  current: SignalLifecycle;
  validTransitions: SignalLifecycle[];
} | null {
  const signal = getSignal(signalId);
  if (!signal) return null;

  const validTransitions = VALID_TRANSITIONS
    .filter(t => t.from === signal.lifecycle)
    .map(t => t.to);

  return {
    current: signal.lifecycle,
    validTransitions,
  };
}
