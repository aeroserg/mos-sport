import { API_BASE_URL, COMMON_HEADERS } from '../config'
import { MonitorSlot, OutdoorApiResult } from '../types'
import { buildQueryString } from '../utils/domain'
import { getCourtLabel, getEventTypeLabel, getVenueLabel } from '../utils/domain'
import { nowIso } from '../utils/date'

export async function callOutdoorApi(endpoint: string, method: string, body?: unknown): Promise<OutdoorApiResult> {
  try {
    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
      method,
      headers: COMMON_HEADERS,
      body: body ? JSON.stringify(body) : undefined
    })

    const contentType = response.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      return {
        status: response.status,
        body: await response.json(),
        isJson: true
      }
    }

    return {
      status: response.status,
      body: await response.text(),
      isJson: false
    }
  } catch (error) {
    return {
      status: 502,
      body: {
        error: 'fetch_failed',
        message: error instanceof Error ? error.message : 'Unknown fetch error'
      },
      isJson: true
    }
  }
}

export function normalizeDateOptionSlots(payload: any): MonitorSlot[] {
  const serverNow = payload?.server_now || nowIso()
  const courts = Array.isArray(payload?.courts) ? payload.courts : []

  return courts.flatMap((court: any) => {
    const availableEvents = Array.isArray(court.available_events) ? court.available_events : []

    return availableEvents.flatMap((event: any) => {
      const availableSlots = Array.isArray(event.available_slots) ? event.available_slots : []

      return availableSlots.map((slot: any) => {
        const bookingOpensAt = slot.booking_opens_at || ''

        return {
          source: 'date-options' as const,
          venue_id: String(event.venue_id || payload.venue_id || ''),
          venue_title: getVenueLabel(event.venue_id || payload.venue_id),
          court_id: String(event.court_id || court.court_id || ''),
          court_title: court.court_title || getCourtLabel(event.venue_id || payload.venue_id, event.court_id || court.court_id),
          event_type: event.event_type || payload.event_type,
          event_title: event.title || getEventTypeLabel(event.event_type || payload.event_type),
          event_id: Number(event.event_id || event.id || 0),
          event_date: event.event_date || (event.starts_at ? event.starts_at.slice(0, 10) : ''),
          starts_at: slot.starts_at || event.starts_at || '',
          ends_at: slot.ends_at || event.ends_at || '',
          duration_minutes: Number(slot.duration_minutes || 0),
          booking_opens_at: bookingOpensAt,
          booking_open: bookingOpensAt ? new Date(serverNow).getTime() >= new Date(bookingOpensAt).getTime() : null,
          enabled: null,
          available_tickets: Number(slot.available_tickets ?? 0),
          raw_available_tickets: Number(slot.raw_available_tickets ?? slot.available_tickets ?? 0)
        }
      })
    })
  })
}

export function normalizeAvailabilitySlots(
  payload: any,
  context: { venue_id: string; court_id: string; event_type: string; date: string }
): MonitorSlot[] {
  const events = Array.isArray(payload?.events) ? payload.events : []

  return events.flatMap((event: any) => {
    const starts = Array.isArray(event.starts) ? event.starts : []

    return starts.flatMap((start: any) =>
      Object.entries(start.durations || {}).map(([durationKey, durationValue]: [string, any]) => {
        const durationMinutes = Number(durationKey)
        const startsAt = start.starts_at || ''
        let endsAt = durationValue?.ends_at || ''

        if (!endsAt && startsAt && Number.isFinite(durationMinutes)) {
          const endDate = new Date(startsAt)
          endDate.setMinutes(endDate.getMinutes() + durationMinutes)
          endsAt = endDate.toISOString()
        }

        return {
          source: 'availability' as const,
          venue_id: String(context.venue_id),
          venue_title: getVenueLabel(context.venue_id),
          court_id: String(context.court_id),
          court_title: getCourtLabel(context.venue_id, context.court_id),
          event_type: event.event_type || context.event_type,
          event_title: event.title || getEventTypeLabel(event.event_type || context.event_type),
          event_id: Number(event.event_id || event.id || 0),
          event_date: context.date,
          starts_at: startsAt,
          ends_at: endsAt,
          duration_minutes: durationMinutes,
          booking_opens_at: '',
          booking_open: durationValue?.booking_open === undefined ? null : Boolean(durationValue.booking_open),
          enabled: durationValue?.enabled === undefined ? null : Boolean(durationValue.enabled),
          available_tickets: Number(durationValue?.available_tickets ?? 0),
          raw_available_tickets: Number(durationValue?.raw_available_tickets ?? durationValue?.available_tickets ?? 0)
        }
      })
    )
  })
}

export function mergeSlots(slots: MonitorSlot[]): MonitorSlot[] {
  const map = new Map<string, MonitorSlot>()

  slots.forEach((slot) => {
    const key = [slot.venue_id, slot.court_id, slot.event_type, slot.event_id, slot.starts_at, slot.duration_minutes].join('|')
    const existing = map.get(key)

    if (!existing) {
      map.set(key, { ...slot })
      return
    }

    map.set(key, {
      ...existing,
      ...slot,
      booking_opens_at: slot.booking_opens_at || existing.booking_opens_at,
      booking_open: slot.booking_open === null ? existing.booking_open : slot.booking_open,
      enabled: slot.enabled === null ? existing.enabled : slot.enabled,
      available_tickets: Math.max(existing.available_tickets || 0, slot.available_tickets || 0),
      raw_available_tickets: Math.max(existing.raw_available_tickets || 0, slot.raw_available_tickets || 0)
    })
  })

  return Array.from(map.values()).sort(
    (left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime()
  )
}

export async function fetchDateOptionsForMonitor(venueId: string, eventType: string): Promise<{
  venue_id: string
  event_type: string
  status: number
  body: any
}> {
  const query = buildQueryString({
    event_type: eventType,
    venue_id: venueId
  })
  const result = await callOutdoorApi(`/booking/date-options${query}`, 'GET')
  return {
    venue_id: String(venueId),
    event_type: eventType,
    status: result.status,
    body: result.isJson ? result.body : {}
  }
}

export async function fetchAvailabilityForMonitor(
  venueId: string,
  courtId: string,
  eventType: string,
  date: string
): Promise<{
  venue_id: string
  court_id: string
  event_type: string
  date: string
  status: number
  body: any
}> {
  const query = buildQueryString({
    event_type: eventType,
    venue_id: venueId,
    court_id: courtId,
    date
  })
  const result = await callOutdoorApi(`/booking/availability${query}`, 'GET')
  return {
    venue_id: String(venueId),
    court_id: String(courtId),
    event_type: eventType,
    date,
    status: result.status,
    body: result.isJson ? result.body : {}
  }
}

export async function createBookingSession(payload: {
  event_type: string
  venue_id: number
  court_id: number
  date: string
}): Promise<OutdoorApiResult> {
  return callOutdoorApi('/booking/session', 'POST', payload)
}

export async function holdBookingSlot(
  sessionId: string,
  payload: {
    event_id: number
    starts_at: string
    ends_at: string
    duration_minutes: number
    tickets_count: number
  }
): Promise<OutdoorApiResult> {
  return callOutdoorApi(`/booking/session/${encodeURIComponent(sessionId)}/hold`, 'PUT', payload)
}

export async function sendBookingSms(payload: {
  session_id: string
  hold_id: string
  phone: string
}): Promise<OutdoorApiResult> {
  return callOutdoorApi('/booking/sms/send', 'POST', payload)
}

export async function verifyBookingSms(payload: {
  session_id: string
  hold_id: string
  phone: string
  code: string
  otp: string
}): Promise<OutdoorApiResult> {
  return callOutdoorApi('/booking/sms/verify', 'POST', payload)
}

export async function confirmBooking(payload: {
  session_id: string
  hold_id: string
  first_name: string
  last_name: string
  phone: string
  email: string
  privacy_policy_accepted: boolean
  personal_data_accepted: boolean
}): Promise<OutdoorApiResult> {
  return callOutdoorApi('/booking/confirm', 'POST', payload)
}
