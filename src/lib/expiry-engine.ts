// Expiry Engine
// Dedicated module for expiry day trading
// Handles weekly and monthly expiry with specific adjustments

import type { SDMOptionStrike, ExpiryWindow, DayMode } from '@/types/sdm';

export interface ExpiryConfig {
  // Gamma window settings (09:15 - 10:30)
  gammaWindowConfidenceBoost: number;
  gammaWindowMaxLots: number;

  // Theta window settings (10:30 - 13:30)
  thetaWindowConfidenceThreshold: number;
  thetaWindowPreferOTM: boolean;

  // Danger window settings (14:00 - 15:30)
  dangerWindowBlockNewTrades: boolean;
  dangerWindowConfidenceThreshold: number;

  // General expiry settings
  maxTradesPerExpiry: number;
  reducePositionSize: number;  // Multiplier (0.5 = 50%)
  requireHigherConfirmation: boolean;
}

export const WEEKLY_EXPIRY_CONFIG: ExpiryConfig = {
  gammaWindowConfidenceBoost: 10,
  gammaWindowMaxLots: 3,
  thetaWindowConfidenceThreshold: 65,
  thetaWindowPreferOTM: true,
  dangerWindowBlockNewTrades: true,
  dangerWindowConfidenceThreshold: 80,
  maxTradesPerExpiry: 4,
  reducePositionSize: 0.6,
  requireHigherConfirmation: true,
};

export const MONTHLY_EXPIRY_CONFIG: ExpiryConfig = {
  gammaWindowConfidenceBoost: 5,
  gammaWindowMaxLots: 5,
  thetaWindowConfidenceThreshold: 60,
  thetaWindowPreferOTM: false,
  dangerWindowBlockNewTrades: false,
  dangerWindowConfidenceThreshold: 70,
  maxTradesPerExpiry: 6,
  reducePositionSize: 0.75,
  requireHigherConfirmation: true,
};

export interface ExpiryAnalysis {
  isExpiryDay: boolean;
  isWeeklyExpiry: boolean;
  isMonthlyExpiry: boolean;
  daysToExpiry: number;
  currentWindow: ExpiryWindow;
  windowLabel: string;
  windowDescription: string;
  timeRemaining: string;
  config: ExpiryConfig;
  recommendations: string[];
  warnings: string[];
}

// ─── Analyze Expiry Conditions ───────────────────────────────────
export function analyzeExpiry(
  expiryDate: string,
  optionChain: SDMOptionStrike[],
  spot: number,
  isWeeklyExpiry: boolean = true
): ExpiryAnalysis {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const today = new Date(now.toISOString().split('T')[0]);
  const expiryDay = new Date(expiry.toISOString().split('T')[0]);

  const isExpiryDay = today.getTime() === expiryDay.getTime();
  const daysToExpiry = Math.max(0, Math.ceil((expiryDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

  // Determine IST time
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  const timeInMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();

  const currentWindow = computeWindow(isExpiryDay, timeInMinutes);
  const config = isWeeklyExpiry ? WEEKLY_EXPIRY_CONFIG : MONTHLY_EXPIRY_CONFIG;

  const analysis: ExpiryAnalysis = {
    isExpiryDay,
    isWeeklyExpiry,
    isMonthlyExpiry: !isWeeklyExpiry,
    daysToExpiry,
    currentWindow,
    windowLabel: getWindowLabel(currentWindow),
    windowDescription: getWindowDescription(currentWindow, isExpiryDay),
    timeRemaining: getTimeRemaining(currentWindow, timeInMinutes),
    config,
    recommendations: [],
    warnings: [],
  };

  // Add recommendations based on window
  if (isExpiryDay) {
    switch (currentWindow) {
      case 'gamma':
        analysis.recommendations.push('Gamma window: High volatility, quick moves');
        analysis.recommendations.push('Best for momentum entries with tight stops');
        analysis.recommendations.push('Prefer ATM or near-ATM strikes');
        break;
      case 'theta':
        analysis.recommendations.push('Theta window: Premium decay accelerating');
        analysis.recommendations.push('Consider OTM strikes for better R:R');
        analysis.recommendations.push('Avoid deep OTM — time decay is brutal');
        break;
      case 'danger':
        analysis.recommendations.push('Danger window: Last 90 minutes');
        analysis.recommendations.push('Focus on managing existing positions');
        if (config.dangerWindowBlockNewTrades) {
          analysis.warnings.push('New trades blocked during danger window');
        }
        break;
      default:
        analysis.recommendations.push('Normal session: Standard trading rules apply');
    }
  } else if (daysToExpiry <= 2) {
    analysis.recommendations.push('Near expiry: Monitor position closely');
    analysis.recommendations.push('Consider early exit if targets met');
  }

  // Check for gamma blast conditions
  if (isExpiryDay && currentWindow === 'gamma') {
    const atm = optionChain.reduce((best, s) =>
      Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
    );
    if (atm) {
      const ceOI = atm.ce?.oi || 0;
      const peOI = atm.pe?.oi || 0;
      const totalOI = ceOI + peOI;
      if (totalOI > 1000000) {
        analysis.warnings.push('High OI at ATM — potential gamma squeeze');
      }
    }
  }

  return analysis;
}

// ─── Compute Window ──────────────────────────────────────────────
function computeWindow(isExpiryDay: boolean, timeInMinutes: number): ExpiryWindow {
  if (!isExpiryDay) return 'normal';
  if (timeInMinutes >= 555 && timeInMinutes < 630) return 'gamma';
  if (timeInMinutes >= 630 && timeInMinutes < 810) return 'theta';
  if (timeInMinutes >= 840 && timeInMinutes <= 930) return 'danger';
  return 'normal';
}

function getWindowLabel(window: ExpiryWindow): string {
  switch (window) {
    case 'gamma': return 'Gamma Window';
    case 'theta': return 'Theta Decay';
    case 'danger': return 'Danger Zone';
    default: return 'Normal';
  }
}

function getWindowDescription(window: ExpiryWindow, isExpiryDay: boolean): string {
  if (!isExpiryDay) return 'Standard trading session';
  switch (window) {
    case 'gamma': return 'High volatility. Quick moves. Momentum entries.';
    case 'theta': return 'Premium decay accelerating. OTM strikes preferred.';
    case 'danger': return 'Last 90 minutes. Focus on exits. No new entries.';
    default: return 'Pre-market or post-market';
  }
}

function getTimeRemaining(window: ExpiryWindow, timeInMinutes: number): string {
  if (window === 'gamma') return `${Math.max(0, 630 - timeInMinutes)} min`;
  if (window === 'theta') return `${Math.max(0, 810 - timeInMinutes)} min`;
  if (window === 'danger') return `${Math.max(0, 930 - timeInMinutes)} min`;
  return 'N/A';
}

// ─── Get Expiry-Adjusted Confidence Threshold ────────────────────
export function getExpiryConfidenceThreshold(
  window: ExpiryWindow,
  isWeeklyExpiry: boolean = true
): number {
  const config = isWeeklyExpiry ? WEEKLY_EXPIRY_CONFIG : MONTHLY_EXPIRY_CONFIG;

  switch (window) {
    case 'gamma': return 55; // Lower threshold during gamma (momentum)
    case 'theta': return config.thetaWindowConfidenceThreshold;
    case 'danger': return config.dangerWindowConfidenceThreshold;
    default: return 55;
  }
}

// ─── Get Expiry Position Size Multiplier ─────────────────────────
export function getExpiryPositionMultiplier(
  window: ExpiryWindow,
  isWeeklyExpiry: boolean = true
): number {
  const config = isWeeklyExpiry ? WEEKLY_EXPIRY_CONFIG : MONTHLY_EXPIRY_CONFIG;

  switch (window) {
    case 'gamma': return 0.5; // Half size during gamma
    case 'theta': return config.reducePositionSize;
    case 'danger': return 0.25; // Quarter size during danger
    default: return 1.0;
  }
}
