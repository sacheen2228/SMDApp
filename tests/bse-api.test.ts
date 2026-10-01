import { describe, test, expect } from 'bun:test';
import { isBSEIndex, getBseScripCd, getBSEIndexData } from '../src/lib/bse-api';

describe('bse-api — scrip map', () => {
  test('isBSEIndex recognizes SENSEX/BANKEX only', () => {
    expect(isBSEIndex('SENSEX')).toBe(true);
    expect(isBSEIndex('sensex')).toBe(true);
    expect(isBSEIndex('BANKEX')).toBe(true);
    expect(isBSEIndex('NIFTY')).toBe(false);
    expect(isBSEIndex('SENSEXIT')).toBe(false);
  });

  test('getBseScripCd returns BSE scrip codes', () => {
    expect(getBseScripCd('SENSEX')).toBe(1);
    expect(getBseScripCd('BANKEX')).toBe(12);
    expect(getBseScripCd('NIFTY')).toBeNull();
  });
});

describe('bse-api — live spot', () => {
  test('getBSEIndexData falls back to option-chain UlaValue when GetSensexDatanew is dead (403/302)', async () => {
    const d = await getBSEIndexData('SENSEX');
    expect(d).not.toBeNull();
    expect(d!.spotPrice).toBeGreaterThan(50000);
    expect(d!.source).toBe('bse-api-chain');
  }, 25000);
});
