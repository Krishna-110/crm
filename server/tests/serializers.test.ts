/**
 * Phase 1 — IST date derivation. No database, no HTTP.
 *
 * serializeRenewal() reimplements in TypeScript what the SQL view renewals_view used to
 * compute:
 *   days_remaining = expiry_date::date - CURRENT_DATE
 *   status         = compute_renewal_status(renewal_date, expiry_date, renewed_at)
 *
 * Prisma 7 forbids @id on views and reports every view column as nullable, so the route
 * reads the base `renewals` table and derives these here instead. That makes this the one
 * place where a timezone mistake silently changes user-visible data rather than crashing.
 *
 * CURRENT_DATE is evaluated in the database session's Asia/Kolkata timezone. IST is
 * UTC+5:30, so between 18:30 and 24:00 UTC the IST calendar date is already tomorrow —
 * roughly the first six hours of every IST day. Comparing against a UTC "today" during that
 * window is off by one, which is exactly what the boundary cases below pin down.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { serializeRenewal } from '../src/serializers.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Freeze wall-clock time at a precise instant. */
function freeze(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

/** A renewal row with no precomputed status/days_remaining, forcing TS derivation. */
function renewalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    customer_id: 'c1',
    customer_name: 'Test Customer',
    medicine_name: 'Metformin',
    order_date: new Date('2026-06-12T09:30:00Z'),
    renewal_date: new Date('2026-08-05T04:30:00Z'),
    expiry_date: new Date('2026-08-11T04:30:00Z'),
    renewed_at: null,
    assigned_caller_id: 'caller-1',
    ...over,
  };
}

describe('serializeRenewal — status derivation', () => {
  it('renewed_at set wins over every date comparison', () => {
    freeze('2026-07-31T06:00:00Z');
    const r = serializeRenewal(renewalRow({ renewed_at: new Date('2026-07-02T04:00:00Z') }));
    expect(r.status).toBe('renewed');
  });

  it('expiry in the past is overdue', () => {
    freeze('2026-07-31T06:00:00Z'); // IST 2026-07-31 11:30
    const r = serializeRenewal(renewalRow({ expiry_date: new Date('2026-07-22T05:30:00Z') }));
    expect(r.status).toBe('overdue');
    expect(r.daysRemaining).toBeLessThan(0);
  });

  it('renewal date reached but not yet expired is due_today', () => {
    freeze('2026-07-31T06:00:00Z');
    const r = serializeRenewal(
      renewalRow({
        renewal_date: new Date('2026-07-30T04:30:00Z'), // already passed
        expiry_date: new Date('2026-08-11T04:30:00Z'), // still ahead
      }),
    );
    expect(r.status).toBe('due_today');
  });

  it('both dates ahead is upcoming', () => {
    freeze('2026-07-31T06:00:00Z');
    const r = serializeRenewal(renewalRow());
    expect(r.status).toBe('upcoming');
    expect(r.daysRemaining).toBeGreaterThan(0);
  });
});

describe('serializeRenewal — IST calendar boundary', () => {
  // 20:00Z is 01:30 IST the NEXT day. "Today" in IST is 2026-08-01, while UTC still reads
  // 2026-07-31. Every assertion here fails if the implementation reduces dates in UTC.
  const LATE_UTC = '2026-07-31T20:00:00Z';

  it('counts days against the IST date, not the UTC date', () => {
    freeze(LATE_UTC);
    // 2026-08-01 10:00 IST — the same IST calendar day as "now".
    const r = serializeRenewal(renewalRow({ expiry_date: new Date('2026-08-01T04:30:00Z') }));
    // IST: both are 2026-08-01 -> 0. UTC would read 2026-07-31 vs 2026-08-01 -> 1.
    expect(r.daysRemaining).toBe(0);
  });

  it('is not overdue on its own expiry day in IST', () => {
    freeze(LATE_UTC);
    const r = serializeRenewal(
      renewalRow({
        renewal_date: new Date('2026-07-20T04:30:00Z'),
        expiry_date: new Date('2026-08-01T04:30:00Z'),
      }),
    );
    expect(r.status).toBe('due_today');
    expect(r.status).not.toBe('overdue');
  });

  it('an expiry one IST day earlier is overdue by exactly one day', () => {
    freeze(LATE_UTC);
    // 2026-07-31 10:00 IST — yesterday relative to the IST "today" of 2026-08-01.
    const r = serializeRenewal(renewalRow({ expiry_date: new Date('2026-07-31T04:30:00Z') }));
    expect(r.daysRemaining).toBe(-1);
    expect(r.status).toBe('overdue');
  });

  it('handles a month boundary without drift', () => {
    freeze('2026-08-31T20:00:00Z'); // IST 2026-09-01 01:30
    const r = serializeRenewal(renewalRow({ expiry_date: new Date('2026-09-05T04:30:00Z') }));
    expect(r.daysRemaining).toBe(4); // Sep 1 -> Sep 5
  });

  it('handles a year boundary without drift', () => {
    freeze('2026-12-31T20:00:00Z'); // IST 2027-01-01 01:30
    const r = serializeRenewal(renewalRow({ expiry_date: new Date('2027-01-03T04:30:00Z') }));
    expect(r.daysRemaining).toBe(2);
  });
});

describe('serializeRenewal — precomputed columns win', () => {
  // renewals_view still supplies these; when present they must pass through untouched
  // rather than being recomputed, so the view and the table agree.
  it('uses row.status and row.days_remaining when the view provided them', () => {
    freeze('2026-07-31T06:00:00Z');
    const r = serializeRenewal(renewalRow({ status: 'overdue', days_remaining: -42 }));
    expect(r.status).toBe('overdue');
    expect(r.daysRemaining).toBe(-42);
  });

  it('treats days_remaining of 0 as provided, not missing', () => {
    // A falsy-but-present 0 must not fall through to recomputation.
    freeze('2026-07-31T06:00:00Z');
    const r = serializeRenewal(renewalRow({ days_remaining: 0 }));
    expect(r.daysRemaining).toBe(0);
  });
});
