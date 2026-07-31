/**
 * Indian mobile normalisation.
 *
 * Digits only, then strip a +91 country code (12 digits starting 91) or a trunk 0
 * (11 digits starting 0), leaving the bare 10-digit number.
 *
 * Deliberately does NOT validate. Callers type numbers in many shapes and the point here is
 * that two spellings of the same number compare equal — rejecting unusual input would lose
 * data that the previous system accepted.
 */
export function normalizeIndianMobile(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(-10);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(-10);
  return digits;
}
