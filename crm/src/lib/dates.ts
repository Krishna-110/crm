/**
 * Date handling, all of it in IST.
 *
 * This app is used in one timezone and every user-visible date figure — renewal status,
 * follow-up buckets, dashboard periods — is an IST calendar date. Deriving those from UTC is
 * wrong for the first 5.5 hours of every IST day, which is the kind of bug that produces a
 * dashboard disagreeing with the list beside it and no error anywhere.
 *
 * So the timezone is explicit here rather than inherited from the server's locale.
 */
export const APP_TIMEZONE = 'Asia/Kolkata';

const dateOnly = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The IST calendar date of an instant, as YYYY-MM-DD. */
export const istDate = (d: Date): string => dateOnly.format(d);

/**
 * Whole days between two instants, compared as IST calendar dates.
 *
 * Both sides are reduced to a wall-clock date first, so the result is a pure day difference
 * with no partial-day or offset drift.
 */
export function istDayDiff(from: Date, to: Date): number {
  const a = Date.parse(`${istDate(from)}T00:00:00Z`);
  const b = Date.parse(`${istDate(to)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

export type RenewalStatus = 'upcoming' | 'due_today' | 'overdue' | 'renewed';

/**
 * A renewal's status, derived rather than stored.
 *
 * Storing it would mean a nightly job to keep it true, and a row whose status is a day stale
 * whenever that job fails. Deriving it costs nothing and cannot drift.
 */
export function renewalStatus(
  renewalDate: Date,
  expiryDate: Date,
  renewedAt: Date | null,
  now = new Date(),
): RenewalStatus {
  if (renewedAt) return 'renewed';
  if (istDayDiff(expiryDate, now) < 0) return 'overdue';
  if (istDayDiff(renewalDate, now) <= 0) return 'due_today';
  return 'upcoming';
}

/** Days until expiry, negative once overdue. */
export const daysRemaining = (expiryDate: Date, now = new Date()): number =>
  istDayDiff(expiryDate, now);

/** IST day/week/month boundaries for the dashboard, as instants. */
export function periodBoundaries(now = new Date()) {
  const today = new Date(`${istDate(now)}T00:00:00+05:30`);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Week starts Monday, matching the previous date_trunc('week', ...) behaviour.
  const weekStart = new Date(today);
  const dow = (weekStart.getDay() + 6) % 7;
  weekStart.setDate(weekStart.getDate() - dow);

  const [y, m] = istDate(now).split('-');
  const monthStart = new Date(`${y}-${m}-01T00:00:00+05:30`);

  return { today, tomorrow, weekStart, monthStart };
}
