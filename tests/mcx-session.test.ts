// MCX Session Engine — offline tests
// Covers: US-DST end time, executable window, holidays, weekend, phase fields.

import { describe, test, expect } from 'bun:test';
import {
  getMCXSession,
  isMCXTradingDay,
  isMCXSignalWindow,
  isUsDaylightTime,
  getMCXEndTimeIST,
  MCX_HOLIDAYS,
  MCX_SIGNAL_WINDOW,
  getMCXSessionLabel,
} from '@/lib/mcx/session';
import { NSE_HOLIDAYS } from '@/lib/expiry-calculator';

const ist = (iso: string) => new Date(iso); // e.g. '2026-06-15T18:30:00+05:30'

describe('MCX session — US daylight time', () => {
  test('June is US daylight time; January is not', () => {
    expect(isUsDaylightTime(ist('2026-06-15T12:00:00+05:30'))).toBe(true);
    expect(isUsDaylightTime(ist('2026-01-15T12:00:00+05:30'))).toBe(false);
  });

  test('starts after the 2nd Sunday of March', () => {
    expect(isUsDaylightTime(ist('2026-03-01T12:00:00+05:30'))).toBe(false); // before
    expect(isUsDaylightTime(ist('2026-03-20T12:00:00+05:30'))).toBe(true); // after Mar 8
  });

  test('ends at the 1st Sunday of November', () => {
    expect(isUsDaylightTime(ist('2026-10-15T12:00:00+05:30'))).toBe(true);
    expect(isUsDaylightTime(ist('2026-11-10T12:00:00+05:30'))).toBe(false); // after Nov 1
  });

  test('end time is 23:55 during US DST and 23:30 otherwise', () => {
    expect(getMCXEndTimeIST(ist('2026-06-15T12:00:00+05:30'))).toBe('23:55');
    expect(getMCXEndTimeIST(ist('2026-01-15T12:00:00+05:30'))).toBe('23:30');
  });

  test('DST overrides a hardcoded 23:30 spec end time', () => {
    expect(getMCXEndTimeIST(ist('2026-06-15T12:00:00+05:30'), '23:30')).toBe('23:55');
    expect(getMCXEndTimeIST(ist('2026-01-15T12:00:00+05:30'), '23:30')).toBe('23:30');
  });
});

describe('MCX session — executable signal window (17:30-22:00 IST)', () => {
  test('window bounds are 17:30 and 22:00', () => {
    expect(MCX_SIGNAL_WINDOW.start).toBe(17 * 60 + 30);
    expect(MCX_SIGNAL_WINDOW.end).toBe(22 * 60);
  });

  test('inside the window', () => {
    expect(isMCXSignalWindow(ist('2026-06-15T17:30:00+05:30'))).toBe(true);
    expect(isMCXSignalWindow(ist('2026-06-15T18:30:00+05:30'))).toBe(true);
    expect(isMCXSignalWindow(ist('2026-06-15T21:59:00+05:30'))).toBe(true);
  });

  test('outside the window', () => {
    expect(isMCXSignalWindow(ist('2026-06-15T17:29:00+05:30'))).toBe(false);
    expect(isMCXSignalWindow(ist('2026-06-15T22:00:00+05:30'))).toBe(false);
    expect(isMCXSignalWindow(ist('2026-06-15T09:15:00+05:30'))).toBe(false);
  });
});

describe('MCX session — trading days', () => {
  test('weekends are not trading days', () => {
    expect(isMCXTradingDay(ist('2026-06-14T12:00:00+05:30'))).toBe(false); // Sunday
    expect(isMCXTradingDay(ist('2026-06-13T12:00:00+05:30'))).toBe(false); // Saturday
  });

  test('a normal weekday is a trading day', () => {
    expect(isMCXTradingDay(ist('2026-06-16T12:00:00+05:30'))).toBe(true); // Tuesday
  });

  test('a known exchange holiday is closed', () => {
    expect(isMCXTradingDay(ist('2026-11-24T12:00:00+05:30'))).toBe(false); // Tue, holiday
  });

  test('MCX_HOLIDAYS is a superset of NSE_HOLIDAYS', () => {
    for (const h of NSE_HOLIDAYS) {
      expect(MCX_HOLIDAYS.has(h)).toBe(true);
    }
  });
});

describe('MCX session — info object', () => {
  test('exposes the new window/trading-day fields', () => {
    const s = getMCXSession();
    expect(typeof s.isSignalWindow).toBe('boolean');
    expect(typeof s.signalsAllowed).toBe('boolean');
    expect(typeof s.isTradingDay).toBe('boolean');
    expect(getMCXSessionLabel(s.state)).toBeTruthy();
  });
});
