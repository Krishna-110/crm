import { describe, it, expect, afterEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { normalizeIndianMobile } from '../src/lib/mobile.js';
import { daysRemaining, istDate, istDayDiff, periodBoundaries, renewalStatus } from '../src/lib/dates.js';
import { lineTotal, payableAmount } from '../src/services/orders.js';
import { diff } from '../src/services/audit.js';

/**
 * Pure logic — no database, no HTTP.
 *
 * Everything here used to be SQL: mobile normalisation and renewal status were PL/pgSQL
 * functions, line totals and payable amounts were GENERATED columns, and the audit diff was
 * a loop over jsonb keys. Being ordinary functions is most of the value of the rewrite, and
 * this file is where that value gets collected.
 */

afterEach(() => vi.useRealTimers());
const freeze = (iso: string) => { vi.useFakeTimers(); vi.setSystemTime(new Date(iso)); };

describe('mobile normalisation', () => {
  it('reduces every spelling of a number to the same ten digits', () => {
    for (const input of ['9876543210', '+91 98765 43210', '919876543210', '09876543210', '98765-43210']) {
      expect(normalizeIndianMobile(input)).toBe('9876543210');
    }
  });

  it('passes through anything it cannot recognise, rather than rejecting it', () => {
    // Deliberate: the point is that two spellings compare equal, not validation. Rejecting
    // unusual input would lose data the system previously accepted.
    expect(normalizeIndianMobile('12345')).toBe('12345');
    expect(normalizeIndianMobile(null)).toBeNull();
    expect(normalizeIndianMobile(undefined)).toBeNull();
  });
});

describe('IST dates', () => {
  it('reads the calendar date in IST, not UTC', () => {
    // 20:00Z is 01:30 IST the next day — the window where a UTC-based implementation is
    // wrong, every single day.
    expect(istDate(new Date('2026-07-31T20:00:00Z'))).toBe('2026-08-01');
    expect(istDate(new Date('2026-07-31T06:00:00Z'))).toBe('2026-07-31');
  });

  it('counts whole days between IST calendar dates', () => {
    const late = new Date('2026-07-31T20:00:00Z'); // IST 2026-08-01
    expect(istDayDiff(new Date('2026-08-01T04:30:00Z'), late)).toBe(0);  // same IST day
    expect(istDayDiff(new Date('2026-07-31T04:30:00Z'), late)).toBe(-1); // the day before
    expect(istDayDiff(new Date('2026-08-05T04:30:00Z'), late)).toBe(4);
  });

  it('crosses month and year boundaries without drift', () => {
    expect(istDayDiff(new Date('2026-09-05T04:30:00Z'), new Date('2026-08-31T20:00:00Z'))).toBe(4);
    expect(istDayDiff(new Date('2027-01-03T04:30:00Z'), new Date('2026-12-31T20:00:00Z'))).toBe(2);
  });

  it('derives renewal status from the two dates and the renewal mark', () => {
    const now = new Date('2026-07-31T06:00:00Z');
    const d = (s: string) => new Date(s);
    expect(renewalStatus(d('2026-08-05'), d('2026-08-11'), null, now)).toBe('upcoming');
    expect(renewalStatus(d('2026-07-30'), d('2026-08-11'), null, now)).toBe('due_today');
    expect(renewalStatus(d('2026-07-01'), d('2026-07-22'), null, now)).toBe('overdue');
    // A renewed row is renewed regardless of its dates.
    expect(renewalStatus(d('2026-07-01'), d('2026-07-22'), d('2026-07-02'), now)).toBe('renewed');
  });

  it('is not overdue on its own expiry day', () => {
    const now = new Date('2026-07-31T20:00:00Z'); // IST 2026-08-01
    expect(renewalStatus(new Date('2026-07-20'), new Date('2026-08-01T04:30:00Z'), null, now)).toBe('due_today');
    expect(daysRemaining(new Date('2026-08-01T04:30:00Z'), now)).toBe(0);
  });

  it('places period boundaries on IST midnight, with weeks starting Monday', () => {
    freeze('2026-07-31T20:00:00Z'); // IST Saturday 2026-08-01
    const { today, tomorrow, weekStart, monthStart } = periodBoundaries();
    expect(istDate(today)).toBe('2026-08-01');
    expect(istDate(tomorrow)).toBe('2026-08-02');
    expect(istDate(weekStart)).toBe('2026-07-27'); // the Monday
    expect(istDate(monthStart)).toBe('2026-08-01');
  });
});

describe('order pricing', () => {
  it('multiplies a line without floating-point error', () => {
    // Decimal rather than number: 0.1 + 0.2 problems in money are unacceptable, which is
    // why the columns are numeric and the arithmetic uses Prisma.Decimal.
    expect(lineTotal(3, 25.5).toString()).toBe('76.5');
    expect(lineTotal(3, new Prisma.Decimal('0.1')).toString()).toBe('0.3');
  });

  it('applies flat and percentage discounts', () => {
    expect(payableAmount(1000, 'none', 0).toString()).toBe('1000');
    expect(payableAmount(1000, 'flat', 250).toString()).toBe('750');
    expect(payableAmount(1000, 'percentage', 10).toString()).toBe('900');
  });

  it('never returns a negative payable amount', () => {
    // A discount larger than the order floors at zero rather than producing a refund.
    expect(payableAmount(100, 'flat', 500).toString()).toBe('0');
    expect(payableAmount(100, 'percentage', 150).toString()).toBe('0');
  });
});

describe('audit diff', () => {
  it('records only the fields that changed', () => {
    const d = diff({ id: '1', name: 'A', phone: '1' }, { id: '1', name: 'B', phone: '1' });
    expect(d).toEqual({ old: { name: 'A' }, new: { name: 'B' } });
  });

  it('returns null when nothing changed, so no entry is written', () => {
    expect(diff({ id: '1', name: 'A' }, { id: '1', name: 'A' })).toBeNull();
  });

  it('ignores updatedAt, which changes on every write', () => {
    // Otherwise every no-op update would produce an audit entry saying only that a timestamp
    // moved, which buries the real changes.
    const d = diff(
      { id: '1', name: 'A', updatedAt: new Date('2026-01-01') },
      { id: '1', name: 'A', updatedAt: new Date('2026-06-01') },
    );
    expect(d).toBeNull();
  });

  it('treats a value becoming null as a change', () => {
    expect(diff({ id: '1', notes: 'x' }, { id: '1', notes: null })).toEqual({
      old: { notes: 'x' },
      new: { notes: null },
    });
  });
});
