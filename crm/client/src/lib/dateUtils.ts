/**
 * Utility functions for Indian Date and Time formatting (en-IN locale)
 */

function parseToDate(input: string | Date | null | undefined): Date | null {
  if (!input) return null
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input

  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return null

    // If it's a simple YYYY-MM-DD date string, parse parts to avoid UTC shift
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [y, m, d] = trimmed.split('-').map(Number)
      return new Date(y, m - 1, d)
    }

    const parsed = new Date(trimmed)
    return isNaN(parsed.getTime()) ? null : parsed
  }

  return null
}

/**
 * Formats a date string or Date object into Indian Date format (en-IN).
 * Default style: 'medium' ('24 Jul 2026') or 'numeric' ('24/07/2026').
 */
export function formatIndianDate(
  input: string | Date | null | undefined,
  style: 'numeric' | 'medium' | 'full' = 'numeric',
): string {
  const d = parseToDate(input)
  if (!d) return '-'

  if (style === 'numeric') {
    return d.toLocaleDateString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })
  }

  if (style === 'medium') {
    return d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })
  }

  return d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

/**
 * Formats a date string or Date object into Indian Date & Time format.
 * Example output: '24/07/2026, 04:45 PM' or '24 Jul 2026, 04:45 PM'
 */
export function formatIndianDateTime(
  input: string | Date | null | undefined,
  style: 'numeric' | 'medium' = 'medium',
): string {
  const d = parseToDate(input)
  if (!d) return '-'

  if (style === 'numeric') {
    return d.toLocaleString('en-IN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    })
  }

  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * Formats time only in Indian 12-hour format (e.g. '04:45 PM').
 */
export function formatIndianTime(input: string | Date | null | undefined): string {
  const d = parseToDate(input)
  if (!d) return '-'

  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })
}
