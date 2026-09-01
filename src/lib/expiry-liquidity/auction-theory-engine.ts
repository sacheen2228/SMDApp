// ─── Auction Theory Engine ─────────────────────────────────────────────
// Classifies market state using Auction Market Theory:
// Balance, Imbalance, Acceptance, Rejection, Value Migration, etc.

import { AuctionTheoryAnalysis, AuctionState, AcceptanceType } from './types';

interface AuctionTheoryConfig {
  valueAreaPercent: number;
  pocMigrationThreshold: number;
  vahValMigrationThreshold: number;
}

class AuctionTheoryEngine {
  private config: AuctionTheoryConfig = {
    valueAreaPercent: 0.70,
    pocMigrationThreshold: 0.002,    // 0.2%
    vahValMigrationThreshold: 0.002, // 0.2%
  };

  // ─── Classify Auction State ──────────────────────────────────────────
  classify(currentProfile: {
    poc: number;
    vah: number;
    val: number;
    currentPrice: number;
  }, previousProfile: {
    poc: number;
    vah: number;
    val: number;
  } | null, currentPrice: number): any {
    // Auction State (Price location relative to Value Area)
    let state: string;
    let location: 'ABOVE_VAH' | 'INSIDE_VALUE' | 'BELOW_VAL';

    if (currentPrice > currentProfile.vah) {
      state = 'PRICE_ABOVE_VALUE';
      location = 'ABOVE_VAH';
    } else if (currentPrice < currentProfile.val) {
      state = 'PRICE_BELOW_VALUE';
      location = 'BELOW_VAL';
    } else {
      state = 'PRICE_INSIDE_VALUE';
      location = 'INSIDE_VALUE';
    }

    // Acceptance/Rejection analysis
    let acceptanceType: string = 'BALANCE';

    if (previousProfile) {
      const pocMigration = currentProfile.poc - previousProfile.poc;
      const vahMigration = currentProfile.vah - previousProfile.vah;
      const valMigration = currentProfile.val - previousProfile.val;

      const pocMigrationPct = previousProfile.poc > 0
        ? pocMigration / previousProfile.poc
        : 0;
      const vahMigrationPct = previousProfile.vah > 0
        ? (currentProfile.vah - previousProfile.vah) / previousProfile.vah
        : 0;
      const valMigrationPct = previousProfile.val > 0
        ? (currentProfile.val - previousProfile.val) / previousProfile.val
        : 0;

      const valueAreaExpanded = (currentProfile.vah - currentProfile.val) >
        (previousProfile.vah - previousProfile.val) * 1.1;
      const valueAreaContracted = (currentProfile.vah - currentProfile.val) <
        (previousProfile.vah - previousProfile.val) * 0.9;

      // Check rejection (price visited level but closed away)
      const visitedVAH = currentPrice >= currentProfile.vah * 0.999 &&
        currentPrice < currentProfile.vah;
      const visitedVAL = currentPrice <= currentProfile.val * 1.001 &&
        currentPrice > currentProfile.val;

      // Determine acceptance type
      if (pocMigrationPct > this.config.pocMigrationThreshold) {
        acceptanceType = 'VALUE_MIGRATION_HIGHER';
      } else if (pocMigrationPct < -this.config.pocMigrationThreshold) {
        acceptanceType = 'VALUE_MIGRATION_LOWER';
      } else if (visitedVAH && currentPrice < currentProfile.vah) {
        acceptanceType = 'REJECTION';
      } else if (visitedVAL && currentPrice > currentProfile.val) {
        acceptanceType = 'REJECTION';
      } else if (valueAreaExpanded) {
        acceptanceType = 'VALUE_EXPANSION';
      } else if (valueAreaContracted) {
        acceptanceType = 'VALUE_CONTRACTION';
      } else if (Math.abs(pocMigrationPct) < this.config.pocMigrationThreshold) {
        acceptanceType = 'BALANCE';
      } else {
        acceptanceType = 'IMBALANCE';
      }
    } else {
      acceptanceType = 'BALANCE';
    }

    // Initiative buying/selling
    const initiativeBuying = this.detectInitiativeBuying(currentPrice, currentProfile);
    const initiativeSelling = this.detectInitiativeSelling(currentPrice, currentProfile);

    // Failed auction
    const failedAuction = this.detectFailedAuction(currentPrice, currentProfile);

    // Balance check
    const balance = Math.abs(currentProfile.poc - (currentProfile.vah + currentProfile.val) / 2) <
      (currentProfile.vah - currentProfile.val) * 0.1;

    return {
      state,
      poc: currentProfile.poc,
      vah: currentProfile.vah,
      val: currentProfile.val,
      pocMigration: previousProfile ? currentProfile.poc - previousProfile.poc : 0,
      vahMigration: previousProfile ? currentProfile.vah - previousProfile.vah : 0,
      valMigration: previousProfile ? currentProfile.val - previousProfile.val : 0,
      valueAreaExpanded: previousProfile ?
        (currentProfile.vah - currentProfile.val) > (previousProfile.vah - previousProfile.val) * 1.1 : false,
      valueAreaContracted: previousProfile ?
        (currentProfile.vah - currentProfile.val) < (previousProfile.vah - previousProfile.val) * 0.9 : false,
      priceLocation: location,
      acceptanceType,
      rejectionStrength: 0,
      initiativeBuying,
      initiativeSelling,
      failedAuction,
      balance,
    };
  }

  private detectInitiativeBuying(currentPrice: number, profile: { poc: number; vah: number; val: number }): boolean {
    return false;
  }

  private detectInitiativeSelling(currentPrice: number, profile: { poc: number; vah: number; val: number }): boolean {
    return false;
  }

  private detectFailedAuction(currentPrice: number, profile: { poc: number; vah: number; val: number }): boolean {
    const visitedVAH = currentPrice >= profile.vah * 0.999 && currentPrice < profile.vah;
    const visitedVAL = currentPrice <= profile.val * 1.001 && currentPrice > profile.val;
    return (visitedVAH || visitedVAL) && currentPrice >= profile.val && currentPrice <= profile.vah;
  }

  // ─── Detect Rejection ───────────────────────────────────────────────
  detectRejection(
    currentPrice: number,
    profile: { vah: number; val: number },
    previousClose: number
  ): { rejected: boolean; level: 'VAH' | 'VAL' | null; strength: number } {
    const visitedVAH = currentPrice >= profile.vah * 0.999 && currentPrice < profile.vah;
    const visitedVAL = currentPrice <= profile.val * 1.001 && currentPrice > profile.val;

    if (visitedVAH && previousClose < profile.vah) {
      return { rejected: true, level: 'VAH', strength: 80 };
    }
    if (visitedVAL && previousClose > profile.val) {
      return { rejected: true, level: 'VAL', strength: 80 };
    }
    return { rejected: false, level: null, strength: 0 };
  }

  // ─── Detect Value Migration ─────────────────────────────────────────
  detectValueMigration(
    currentProfile: { poc: number; vah: number; val: number },
    previousProfile: { poc: number; vah: number; val: number } | null
  ): 'HIGHER' | 'LOWER' | 'NEUTRAL' {
    if (!previousProfile) return 'NEUTRAL';

    const pocMigration = currentProfile.poc - previousProfile.poc;
    const vahMigration = currentProfile.vah - previousProfile.vah;
    const valMigration = currentProfile.val - previousProfile.val;

    const avgMigration = (pocMigration + vahMigration + valMigration) / 3;
    const avgPrice = (previousProfile.poc + previousProfile.vah + previousProfile.val) / 3;
    const migrationPct = avgPrice > 0 ? (avgMigration / avgPrice) * 100 : 0;

    if (migrationPct > 0.2) return 'HIGHER';
    if (migrationPct < -0.2) return 'LOWER';
    return 'NEUTRAL';
  }

  // ─── Detect Value Area Expansion/Contraction ────────────────────────
  detectValueAreaChange(
    currentProfile: { vah: number; val: number },
    previousProfile: { vah: number; val: number } | null
  ): 'EXPANSION' | 'CONTRACTION' | 'STABLE' {
    if (!previousProfile) return 'STABLE';

    const currentWidth = currentProfile.vah - currentProfile.val;
    const previousWidth = previousProfile.vah - previousProfile.val;
    const widthChangePct = previousWidth > 0
      ? ((currentWidth - previousWidth) / previousWidth) * 100
      : 0;

    if (widthChangePct > 10) return 'EXPANSION';
    if (widthChangePct < -10) return 'CONTRACTION';
    return 'STABLE';
  }

  // ─── Configure ──────────────────────────────────────────────────────
  configure(config: Partial<{ valueAreaPercent: number; pocMigrationThreshold: number; vahValMigrationThreshold: number }>): void {
    if (config.valueAreaPercent) this.config.valueAreaPercent = config.valueAreaPercent;
    if (config.pocMigrationThreshold) this.config.pocMigrationThreshold = config.pocMigrationThreshold;
    if (config.vahValMigrationThreshold) this.config.vahValMigrationThreshold = config.vahValMigrationThreshold;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────
let auctionTheoryEngineInstance: AuctionTheoryEngine | null = null;

export function getAuctionTheoryEngine(): AuctionTheoryEngine {
  if (!auctionTheoryEngineInstance) {
    auctionTheoryEngineInstance = new AuctionTheoryEngine();
  }
  return auctionTheoryEngineInstance;
}

