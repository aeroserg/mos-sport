import { EVENT_TYPE_LABELS, VENUES } from '../config'

export function getEventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] || eventType
}

export function getVenueLabel(venueId: string | number): string {
  return VENUES[String(venueId) as keyof typeof VENUES]?.title || `Площадка ${venueId}`
}

export function getCourtLabel(venueId: string | number, courtId: string | number): string {
  const venue = VENUES[String(venueId) as keyof typeof VENUES]
  if (!venue) {
    return `Корт ${courtId}`
  }

  const index = venue.courts.findIndex((item) => String(item) === String(courtId))
  return index >= 0 ? `Корт ${index + 1}` : `Корт ${courtId}`
}

export function normalizeQueryValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }

  return String(value)
}

export function buildQueryString(query: Record<string, unknown>): string {
  const searchParams = new URLSearchParams()

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return
    }

    searchParams.set(key, normalizeQueryValue(value))
  })

  const result = searchParams.toString()
  return result ? `?${result}` : ''
}

export function jsonParseArray(value: string, fallback: string[] | number[] = []): string[] | number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}
