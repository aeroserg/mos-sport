import { MAX_ALERT_DATE, MONTHS, TIMEZONE } from '../config'

export interface ParsedDateResult {
  ok: boolean
  date?: string
  dates?: string[]
  error?: string
  requiresFutureModeChoice?: boolean
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function formatYmdParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function getMskDateParts(value: Date | string = new Date()): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
} {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })

  const parts = formatter.formatToParts(typeof value === 'string' ? new Date(value) : value)
  const result: Record<string, string> = {}

  parts.forEach((part) => {
    if (part.type !== 'literal') {
      result[part.type] = part.value
    }
  })

  return {
    year: Number(result.year),
    month: Number(result.month),
    day: Number(result.day),
    hour: Number(result.hour),
    minute: Number(result.minute),
    second: Number(result.second)
  }
}

export function getCurrentMskContext(): {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  date: string
} {
  const parts = getMskDateParts()
  return {
    ...parts,
    date: formatYmdParts(parts.year, parts.month, parts.day)
  }
}

export function formatDateHuman(date: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TIMEZONE
  }).format(new Date(`${date}T00:00:00+03:00`))
}

export function formatDateTimeHuman(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: TIMEZONE
  }).format(new Date(value))
}

export function buildSearchDates(daysCount = 3, startValue?: string): string[] {
  const startParts = startValue ? getMskDateParts(startValue) : getCurrentMskContext()
  const startDate = new Date(`${formatYmdParts(startParts.year, startParts.month, startParts.day)}T00:00:00+03:00`)
  const dates: string[] = []

  for (let index = 0; index < daysCount; index += 1) {
    const nextDate = new Date(startDate)
    nextDate.setUTCDate(startDate.getUTCDate() + index)
    const nextParts = getMskDateParts(nextDate)
    dates.push(formatYmdParts(nextParts.year, nextParts.month, nextParts.day))
  }

  return dates
}

export function addDaysYmd(date: string, days: number): string {
  const base = new Date(`${date}T00:00:00+03:00`)
  base.setUTCDate(base.getUTCDate() + days)
  const parts = getMskDateParts(base)
  return formatYmdParts(parts.year, parts.month, parts.day)
}

export function daysBetweenYmd(left: string, right: string): number {
  const leftDate = new Date(`${left}T00:00:00+03:00`).getTime()
  const rightDate = new Date(`${right}T00:00:00+03:00`).getTime()
  return Math.round((rightDate - leftDate) / 86400000)
}

export function isValidYmd(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false
  }

  const [yearRaw, monthRaw, dayRaw] = date.split('-')
  const year = Number(yearRaw)
  const month = Number(monthRaw)
  const day = Number(dayRaw)
  const parsed = new Date(`${date}T00:00:00+03:00`)
  const parts = getMskDateParts(parsed)

  return parts.year === year && parts.month === month && parts.day === day
}

function normalizeDateToken(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function validateParsedDate(date: string, currentDate: string): ParsedDateResult | null {
  if (!isValidYmd(date)) {
    return null
  }

  if (date < currentDate) {
    return { ok: false, error: 'Нельзя выбрать прошедшую дату.' }
  }

  if (date > MAX_ALERT_DATE) {
    return { ok: false, error: `Дата должна быть не позже ${formatDateHuman(MAX_ALERT_DATE)}.` }
  }

  return {
    ok: true,
    date,
    dates: [date],
    requiresFutureModeChoice: daysBetweenYmd(currentDate, date) > 2
  }
}

function findNearestFutureDateByDay(day: number, current: ReturnType<typeof getCurrentMskContext>): string | null {
  for (let monthOffset = 0; monthOffset <= 12; monthOffset += 1) {
    const baseMonthIndex = current.month - 1 + monthOffset
    const year = current.year + Math.floor(baseMonthIndex / 12)
    const month = (baseMonthIndex % 12) + 1
    const candidate = formatYmdParts(year, month, day)

    if (!isValidYmd(candidate)) {
      continue
    }

    if (candidate >= current.date) {
      return candidate
    }
  }

  return null
}

function parseSingleFlexibleDateToken(token: string, current: ReturnType<typeof getCurrentMskContext>): ParsedDateResult {
  const normalized = normalizeDateToken(token)

  if (!normalized) {
    return { ok: false, error: 'Дата не указана.' }
  }

  const candidates: string[] = []

  let match = normalized.match(/^(\d{4})[./\- ](\d{1,2})[./\- ](\d{1,2})$/)
  if (match) {
    candidates.push(formatYmdParts(Number(match[1]), Number(match[2]), Number(match[3])))
  }

  match = normalized.match(/^(\d{1,2})[./\- ](\d{1,2})(?:[./\- ](\d{2,4}))?$/)
  if (match) {
    candidates.push(
      formatYmdParts(
        match[3] ? Number(match[3]) : current.year,
        Number(match[2]),
        Number(match[1])
      )
    )
  }

  match = normalized.match(/^(\d{1,2})$/)
  if (match) {
    const nearest = findNearestFutureDateByDay(Number(match[1]), current)
    if (nearest) {
      candidates.push(nearest)
    }
  }

  match = normalized.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[2]]) {
    candidates.push(
      formatYmdParts(
        match[3] ? Number(match[3]) : current.year,
        MONTHS[match[2]],
        Number(match[1])
      )
    )
  }

  match = normalized.match(/^([а-яё]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[1]]) {
    candidates.push(
      formatYmdParts(
        match[3] ? Number(match[3]) : current.year,
        MONTHS[match[1]],
        Number(match[2])
      )
    )
  }

  for (const candidate of candidates) {
    const validated = validateParsedDate(candidate, current.date)
    if (!validated) {
      continue
    }

    return validated
  }

  return {
    ok: false,
    error:
      'Не понял дату. Примеры: 27, 27.06, 27/06/2026, 2026-06-27, 27 июня. Можно несколько дат через запятую.'
  }
}

function trySplitRange(segment: string, current: ReturnType<typeof getCurrentMskContext>): [string, string] | null {
  const separators = ['-', '–', '—']

  for (let index = 0; index < segment.length; index += 1) {
    if (!separators.includes(segment[index])) {
      continue
    }

    const left = segment.slice(0, index).trim()
    const right = segment.slice(index + 1).trim()

    if (!left || !right) {
      continue
    }

    const leftParsed = parseSingleFlexibleDateToken(left, current)
    const rightParsed = parseSingleFlexibleDateToken(right, current)

    if (leftParsed.ok && rightParsed.ok && leftParsed.date && rightParsed.date) {
      return [leftParsed.date, rightParsed.date]
    }
  }

  return null
}

export function parseFlexibleDateInput(input: string): ParsedDateResult {
  const current = getCurrentMskContext()
  const raw = String(input || '').trim()

  if (!raw) {
    return { ok: false, error: 'Дата не указана.' }
  }

  const parts = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (!parts.length) {
    return { ok: false, error: 'Дата не указана.' }
  }

  const dates: string[] = []

  for (const part of parts) {
    const range = trySplitRange(part, current)

    if (range) {
      const [from, to] = range

      if (to < from) {
        return { ok: false, error: 'В диапазоне конечная дата должна быть не раньше начальной.' }
      }

      const diff = daysBetweenYmd(from, to)
      if (diff > 2) {
        return { ok: false, error: 'Диапазон дат может быть только на 3 дня или меньше.' }
      }

      for (let index = 0; index <= diff; index += 1) {
        dates.push(addDaysYmd(from, index))
      }
      continue
    }

    const parsed = parseSingleFlexibleDateToken(part, current)
    if (!parsed.ok || !parsed.date) {
      return parsed
    }

    dates.push(parsed.date)
  }

  const uniqueDates = Array.from(new Set(dates)).sort((left, right) => left.localeCompare(right))

  return {
    ok: true,
    date: uniqueDates[0],
    dates: uniqueDates,
    requiresFutureModeChoice: uniqueDates.some((date) => daysBetweenYmd(current.date, date) > 2)
  }
}
