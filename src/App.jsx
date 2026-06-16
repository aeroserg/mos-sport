import { useEffect, useMemo, useState } from 'react'

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || 'https://mos-sport.explaingpt.ru/api').replace(/\/$/, '')
const supportedEventTypes = ['free_play', 'masterclass', 'tournament_60', 'tournament_120', 'tournament_180']
const eventTypeLabels = {
  free_play: 'Свободная игра',
  masterclass: 'Мастер-класс',
  tournament_60: 'Турнир 60 минут',
  tournament_120: 'Турнир 120 минут',
  tournament_180: 'Турнир 180 минут'
}
const openingHourMinutes = 10 * 60
const closingHourMinutes = 22 * 60

function formatDateToYmd(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildSearchDates(daysCount = 4, startValue) {
  const dates = []
  const start = startValue ? new Date(startValue) : new Date()
  start.setHours(0, 0, 0, 0)

  for (let index = 0; index < daysCount; index += 1) {
    const nextDate = new Date(start)
    nextDate.setDate(start.getDate() + index)
    dates.push(formatDateToYmd(nextDate))
  }

  return dates
}

const initialForm = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  event_type: 'free_play',
  venue_id: '12',
  court_id: '10',
  date: formatDateToYmd(new Date()),
  start_time: '10:00',
  event_id: '',
  starts_at: '',
  ends_at: '',
  duration_minutes: '60',
  tickets_count: '1',
  privacy_policy_accepted: true,
  personal_data_accepted: true
}

const initialResponses = {
  dateOptions: null,
  availability: null,
  session: null,
  hold: null,
  smsSend: null,
  smsVerify: null,
  confirm: null
}

function formatRemaining(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return '00:00'
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function getResponseData(response) {
  if (!response) {
    return {}
  }

  if (response.data !== undefined) {
    return response.data
  }

  return response
}

function createUrl(url, query) {
  const requestUrl = new URL(`${apiBaseUrl}${url}`, window.location.origin)

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return
    }

    requestUrl.searchParams.set(key, value)
  })

  return requestUrl.toString()
}

function formatDateHuman(value) {
  if (!value) {
    return '—'
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(`${value}T00:00:00`))
}

function formatDateTimeHuman(value) {
  if (!value) {
    return '—'
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function formatTimeHuman(value) {
  if (!value) {
    return '—'
  }

  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

function parseTimeToMinutes(value) {
  if (!value || !value.includes(':')) {
    return null
  }

  const [hoursRaw, minutesRaw] = value.split(':')
  const hours = Number(hoursRaw)
  const minutes = Number(minutesRaw)

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return null
  }

  return hours * 60 + minutes
}

function formatMinutesToTime(totalMinutes) {
  const normalizedMinutes = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60)
  const hours = Math.floor(normalizedMinutes / 60)
  const minutes = normalizedMinutes % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function buildIsoDateTime(date, time) {
  if (!date || !time) {
    return ''
  }

  const normalizedTime = time.length === 5 ? `${time}:00` : time
  return `${date}T${normalizedTime}.000+03:00`
}

function isMonday(date) {
  if (!date) {
    return false
  }

  return new Date(`${date}T00:00:00`).getDay() === 1
}

function isScheduleValid(date, startTime, durationMinutes) {
  const startMinutes = parseTimeToMinutes(startTime)
  const duration = Number(durationMinutes)

  if (!date || startMinutes === null || !Number.isFinite(duration) || duration <= 0) {
    return false
  }

  if (isMonday(date)) {
    return false
  }

  const endMinutes = startMinutes + duration
  return startMinutes >= openingHourMinutes && endMinutes <= closingHourMinutes
}

function getEventTypeLabel(eventType, fallbackTitle) {
  return fallbackTitle || eventTypeLabels[eventType] || eventType || '—'
}

function getCourtVenueId(court) {
  const venueId = court?.venue_id

  if (venueId && typeof venueId === 'object') {
    return venueId.id ?? venueId.venue_id ?? venueId.value ?? ''
  }

  return venueId ?? ''
}

function normalizeDateOptionCourts(response, venueId) {
  const payload = getResponseData(response)
  const courts = Array.isArray(payload?.courts) ? payload.courts : []

  return courts.map((court) => ({
    id: court.court_id,
    title: court.court_title || `Корт ${court.court_number || court.court_id}`,
    name: court.court_title || `Корт ${court.court_number || court.court_id}`,
    venue_id: venueId,
    has_bookable_slots: Boolean(court.has_bookable_slots),
    available_dates: Array.isArray(court.available_dates) ? court.available_dates : [],
    available_events: Array.isArray(court.available_events) ? court.available_events : []
  }))
}

function buildDateOptionsResponseSummary(results, venueId) {
  return {
    venue_id: venueId,
    event_types: results.map((result) => ({
      event_type: result.event_type,
      label: getEventTypeLabel(result.event_type),
      httpStatus: result.httpStatus,
      payload: getResponseData(result)
    }))
  }
}

function buildAvailabilityResponseSummary(results, venueId, dates, ticketsCount) {
  return {
    venue_id: venueId,
    dates,
    tickets_count: ticketsCount,
    requests: results.map((result) => ({
      date: result.date,
      event_type: result.event_type,
      court_id: result.court_id,
      court_title: result.court_title,
      httpStatus: result.httpStatus,
      payload: getResponseData(result)
    }))
  }
}

function extractDirectusItems(response) {
  const payload = getResponseData(response)

  if (Array.isArray(payload?.data)) {
    return payload.data
  }

  if (Array.isArray(payload)) {
    return payload
  }

  if (Array.isArray(payload?.items)) {
    return payload.items
  }

  return []
}

function extractAvailabilityEvents(response) {
  const payload = getResponseData(response)

  if (Array.isArray(payload?.events)) {
    return payload.events
  }

  if (Array.isArray(payload?.data?.events)) {
    return payload.data.events
  }

  return []
}

function buildSlots(events, context = {}) {
  const requiredTickets = Number(context.tickets_count) || 1

  return events.flatMap((event) =>
    (event.starts || []).flatMap((start) => {
      const startsAt = start.starts_at
      const durationOptions = Object.entries(start.durations || {})
        .map(([durationKey, durationValue]) => {
          const durationMinutes = Number(durationKey)
          const endMinutes =
            parseTimeToMinutes(formatTimeHuman(startsAt)) !== null
              ? parseTimeToMinutes(formatTimeHuman(startsAt)) + durationMinutes
              : null

          return {
            key: `${durationMinutes}`,
            duration_minutes: durationMinutes,
            ends_at:
              durationValue?.ends_at ||
              (startsAt && endMinutes !== null
                ? buildIsoDateTime(startsAt.slice(0, 10), formatMinutesToTime(endMinutes))
                : ''),
            available_tickets: Number(durationValue?.available_tickets) || 0,
            enabled: durationValue?.enabled,
            booking_open: durationValue?.booking_open
          }
        })
        .filter((durationOption) => durationOption.available_tickets >= requiredTickets)
        .sort((left, right) => left.duration_minutes - right.duration_minutes)

      if (!durationOptions.length) {
        return []
      }

      return {
        key: [context.event_type || event.event_type || 'free_play', context.court_id || 'court', event.id, startsAt].join(':'),
        event_id: event.id,
        starts_at: startsAt,
        tickets_count: requiredTickets,
        court_id: String(context.court_id || ''),
        court_title: context.court_title || `Корт ${context.court_id || ''}`.trim(),
        venue_id: String(context.venue_id || ''),
        event_title: getEventTypeLabel(context.event_type || event.event_type, event.title),
        event_type: context.event_type || event.event_type || 'free_play',
        max_available_tickets: Math.max(...durationOptions.map((item) => item.available_tickets)),
        duration_options: durationOptions
      }
    })
  )
}

function buildSlotsFromDateOptions(courts, context = {}) {
  const requiredTickets = Number(context.tickets_count) || 1
  const allowedDates = new Set(context.search_dates || [])

  return courts.flatMap((court) =>
    (court.available_events || []).flatMap((event) => {
      const eventDate = event.event_date || (event.starts_at ? event.starts_at.slice(0, 10) : '')

      if (allowedDates.size && eventDate && !allowedDates.has(eventDate)) {
        return []
      }

      const durationOptions = (event.available_slots || [])
        .map((slot) => ({
          key: `${slot.duration_minutes}`,
          duration_minutes: Number(slot.duration_minutes),
          ends_at: slot.ends_at || event.ends_at || '',
          available_tickets: Number(slot.available_tickets ?? slot.raw_available_tickets) || 0,
          booking_opens_at: slot.booking_opens_at || '',
          enabled: true,
          booking_open: true
        }))
        .filter((durationOption) => durationOption.available_tickets >= requiredTickets)
        .sort((left, right) => left.duration_minutes - right.duration_minutes)

      if (!durationOptions.length) {
        return []
      }

      const startsAt = event.starts_at || event.available_slots?.[0]?.starts_at || ''

      return {
        key: [context.event_type || event.event_type || 'free_play', court.id, event.event_id || event.id, startsAt].join(':'),
        event_id: event.event_id || event.id,
        starts_at: startsAt,
        tickets_count: requiredTickets,
        court_id: String(court.id || event.court_id || ''),
        court_title: court.title || court.name || `Корт ${court.id || event.court_id || ''}`.trim(),
        venue_id: String(context.venue_id || event.venue_id || ''),
        event_title: getEventTypeLabel(context.event_type || event.event_type, event.title),
        event_type: context.event_type || event.event_type || 'free_play',
        max_available_tickets: Math.max(...durationOptions.map((item) => item.available_tickets)),
        duration_options: durationOptions
      }
    })
  )
}

function mergeSlots(slots) {
  const slotsMap = new Map()

  slots.forEach((slot) => {
    const slotKey = [slot.event_type, slot.court_id, slot.event_id, slot.starts_at].join(':')
    const existingSlot = slotsMap.get(slotKey)

    if (!existingSlot) {
      slotsMap.set(slotKey, {
        ...slot,
        duration_options: [...slot.duration_options]
      })
      return
    }

    const durationMap = new Map(
      existingSlot.duration_options.map((durationOption) => [String(durationOption.duration_minutes), durationOption])
    )

    slot.duration_options.forEach((durationOption) => {
      const currentOption = durationMap.get(String(durationOption.duration_minutes))

      if (!currentOption || Number(durationOption.available_tickets) > Number(currentOption.available_tickets)) {
        durationMap.set(String(durationOption.duration_minutes), durationOption)
      }
    })

    const mergedDurationOptions = Array.from(durationMap.values()).sort(
      (left, right) => left.duration_minutes - right.duration_minutes
    )

    slotsMap.set(slotKey, {
      ...existingSlot,
      ...slot,
      max_available_tickets: Math.max(...mergedDurationOptions.map((item) => Number(item.available_tickets) || 0)),
      duration_options: mergedDurationOptions
    })
  })

  return Array.from(slotsMap.values())
}

function formatSlotLabel(slot) {
  const availableTickets = slot.max_available_tickets ? ` • до ${slot.max_available_tickets} мест` : ''
  return `${slot.event_title} • ${slot.court_title} • ${formatDateHuman(slot.starts_at.slice(0, 10))} • ${formatTimeHuman(slot.starts_at)}${availableTickets}`
}

async function requestJson(url, method, body, query) {
  try {
    const response = await fetch(createUrl(url, query), {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })

    const contentType = response.headers.get('content-type') || ''

    if (contentType.includes('application/json')) {
      const json = await response.json()
      return {
        httpStatus: response.status,
        ...json
      }
    }

    const rawText = await response.text()
    return {
      httpStatus: response.status,
      status: response.status,
      data: {
        raw_text: rawText
      }
    }
  } catch (error) {
    return {
      httpStatus: 502,
      status: 502,
      data: {
        error: 'fetch_failed',
        message: error instanceof Error ? error.message : 'Неизвестная ошибка сети'
      }
    }
  }
}

export default function App() {
  const [form, setForm] = useState(initialForm)
  const [searchDates, setSearchDates] = useState(() => buildSearchDates(4))
  const [manualMode, setManualMode] = useState(false)
  const [manualCourtMode, setManualCourtMode] = useState(false)
  const [venues, setVenues] = useState([])
  const [dateOptionsCatalog, setDateOptionsCatalog] = useState({})
  const [slots, setSlots] = useState([])
  const [selectedSlotKey, setSelectedSlotKey] = useState('')
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [lookupStatus, setLookupStatus] = useState({
    venues: 'idle',
    dateOptions: 'idle',
    slots: 'idle'
  })
  const [sessionId, setSessionId] = useState('')
  const [holdId, setHoldId] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [availableBeforeHold, setAvailableBeforeHold] = useState(null)
  const [availableAfterHold, setAvailableAfterHold] = useState(null)
  const [responses, setResponses] = useState(initialResponses)
  const [smsCode, setSmsCode] = useState('')
  const [verified, setVerified] = useState(false)
  const [notice, setNotice] = useState('')
  const [smsCooldownUntil, setSmsCooldownUntil] = useState(null)
  const [now, setNow] = useState(Date.now())
  const [loadingStep, setLoadingStep] = useState('')

  const venueMap = useMemo(
    () =>
      new Map(
        venues.map((venue) => [
          String(venue.id),
          `${venue.title || 'Без названия'}, ${venue.address || 'адрес не указан'}`
        ])
      ),
    [venues]
  )

  const eventTypeOptions = useMemo(() => {
    const grouped = new Map()

    slots.forEach((slot) => {
      const key = String(slot.event_type)
      const current = grouped.get(key)

      if (!current) {
        grouped.set(key, {
          value: key,
          label: getEventTypeLabel(key),
          slotsCount: 1
        })
        return
      }

      grouped.set(key, {
        ...current,
        slotsCount: current.slotsCount + 1
      })
    })

    return Array.from(grouped.values()).sort((left, right) => left.label.localeCompare(right.label, 'ru'))
  }, [slots])

  const availableDateOptions = useMemo(() => {
    const grouped = new Map()

    slots
      .filter((slot) => !form.event_type || String(slot.event_type) === String(form.event_type))
      .forEach((slot) => {
        const dateValue = slot.starts_at?.slice(0, 10)
        if (!dateValue) {
          return
        }

        const current = grouped.get(dateValue)
        grouped.set(dateValue, {
          value: dateValue,
          label: formatDateHuman(dateValue),
          slotsCount: (current?.slotsCount || 0) + 1
        })
      })

    return Array.from(grouped.values()).sort((left, right) => left.value.localeCompare(right.value))
  }, [form.event_type, slots])

  const availableCourts = useMemo(() => {
    const grouped = new Map()

    slots
      .filter((slot) => !form.event_type || String(slot.event_type) === String(form.event_type))
      .filter((slot) => !form.date || slot.starts_at?.slice(0, 10) === String(form.date))
      .forEach((slot) => {
        const key = String(slot.court_id)
        const current = grouped.get(key)

        grouped.set(key, {
          id: key,
          title: slot.court_title || `Корт ${key}`,
          name: slot.court_title || `Корт ${key}`,
          slotsCount: (current?.slotsCount || 0) + 1
        })
      })

    return Array.from(grouped.values()).sort((left, right) => left.title.localeCompare(right.title, 'ru'))
  }, [form.date, form.event_type, slots])

  const visibleSlots = useMemo(
    () =>
      slots.filter((slot) => {
        if (form.event_type && String(slot.event_type) !== String(form.event_type)) {
          return false
        }

        if (form.date && slot.starts_at?.slice(0, 10) !== String(form.date)) {
          return false
        }

        if (form.court_id && String(slot.court_id) !== String(form.court_id)) {
          return false
        }

        return true
      }),
    [form.court_id, form.date, form.event_type, slots]
  )

  const courtMap = useMemo(
    () =>
      new Map(
        Object.values(dateOptionsCatalog)
          .flatMap((item) => item.courts || [])
          .map((court) => [
          String(court.id),
          court.title || court.name || `Корт ${court.id}`
        ])
      ),
    [dateOptionsCatalog]
  )

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 1000)

    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    loadVenues()
  }, [])

  useEffect(() => {
    if (!form.venue_id) {
      return
    }

    loadDateOptions()
  }, [form.venue_id])

  useEffect(() => {
    if (manualMode) {
      return
    }

    if (!form.venue_id || !Object.keys(dateOptionsCatalog).length) {
      return
    }

    loadAvailability()
  }, [manualMode, form.venue_id, form.tickets_count, dateOptionsCatalog, searchDates])

  useEffect(() => {
    if (!selectedSlotKey) {
      setSelectedSlot(null)
      return
    }

    const slot = visibleSlots.find((item) => item.key === selectedSlotKey) || null
    setSelectedSlot(slot)

    if (!slot) {
      return
    }

    const selectedDuration =
      slot.duration_options.find((item) => String(item.duration_minutes) === String(form.duration_minutes)) ||
      slot.duration_options[0]

    setForm((current) => ({
      ...current,
      date: slot.starts_at ? slot.starts_at.slice(0, 10) : current.date,
      event_id: String(slot.event_id),
      starts_at: slot.starts_at,
      ends_at: selectedDuration?.ends_at || '',
      start_time: formatTimeHuman(slot.starts_at),
      duration_minutes: selectedDuration ? String(selectedDuration.duration_minutes) : current.duration_minutes,
      event_type: slot.event_type || current.event_type,
      court_id: slot.court_id || current.court_id
    }))
  }, [form.duration_minutes, selectedSlotKey, visibleSlots])

  useEffect(() => {
    if (manualMode || !selectedSlot) {
      return
    }

    const selectedDuration =
      selectedSlot.duration_options.find((item) => String(item.duration_minutes) === String(form.duration_minutes)) || null

    if (!selectedDuration) {
      return
    }

    setForm((current) => ({
      ...current,
      ends_at: selectedDuration.ends_at
    }))
  }, [form.duration_minutes, manualMode, selectedSlot])

  useEffect(() => {
    if (manualMode || manualCourtMode) {
      return
    }

    if (!availableCourts.length) {
      if (form.court_id) {
        setForm((current) => ({
          ...current,
          court_id: ''
        }))
      }
      return
    }

    if (!availableCourts.some((court) => String(court.id) === String(form.court_id))) {
      setForm((current) => ({
        ...current,
        court_id: String(availableCourts[0].id)
      }))
    }
  }, [availableCourts, form.court_id, manualCourtMode, manualMode])

  useEffect(() => {
    if (manualMode) {
      return
    }

    if (eventTypeOptions.some((option) => option.value === form.event_type)) {
      return
    }

    if (!eventTypeOptions.length) {
      if (form.event_type) {
        setForm((current) => ({
          ...current,
          event_type: ''
        }))
      }
      return
    }

    setForm((current) => ({
      ...current,
      event_type: eventTypeOptions[0].value
    }))
  }, [eventTypeOptions, form.event_type, manualMode])

  useEffect(() => {
    if (manualMode) {
      return
    }

    if (availableDateOptions.some((option) => option.value === form.date)) {
      return
    }

    if (!availableDateOptions.length) {
      if (form.date) {
        setForm((current) => ({
          ...current,
          date: ''
        }))
      }
      return
    }

    setForm((current) => ({
      ...current,
      date: availableDateOptions[0].value
    }))
  }, [availableDateOptions, form.date, manualMode])

  useEffect(() => {
    if (!manualMode) {
      return
    }

    const startsAt = buildIsoDateTime(form.date, form.start_time)
    const startMinutes = parseTimeToMinutes(form.start_time)
    const duration = Number(form.duration_minutes)
    const endsAt =
      startMinutes === null || !Number.isFinite(duration) || duration <= 0
        ? ''
        : buildIsoDateTime(form.date, formatMinutesToTime(startMinutes + duration))

    setForm((current) => {
      if (current.starts_at === startsAt && current.ends_at === endsAt) {
        return current
      }

      return {
        ...current,
        starts_at: startsAt,
        ends_at: endsAt
      }
    })
  }, [form.date, form.duration_minutes, form.start_time, manualMode])

  useEffect(() => {
    if (manualMode) {
      return
    }

    if (!visibleSlots.length) {
      setSelectedSlotKey('')
      return
    }

    setSelectedSlotKey((current) => (visibleSlots.some((slot) => slot.key === current) ? current : visibleSlots[0].key))
  }, [manualMode, visibleSlots])

  const expiresInSeconds = useMemo(() => {
    if (!expiresAt) {
      return null
    }

    const diffMs = new Date(expiresAt).getTime() - now
    return Math.max(0, Math.floor(diffMs / 1000))
  }, [expiresAt, now])

  const smsRetryInSeconds = useMemo(() => {
    if (!smsCooldownUntil) {
      return 0
    }

    return Math.max(0, Math.ceil((smsCooldownUntil - now) / 1000))
  }, [smsCooldownUntil, now])

  function updateForm(event) {
    const { name, value, type, checked } = event.target
    setForm((current) => ({
      ...current,
      [name]: type === 'checkbox' ? checked : value
    }))
  }

  async function loadVenues() {
    setLookupStatus((current) => ({ ...current, venues: 'loading' }))

    const response = await requestJson('/venues', 'GET')
    const items = extractDirectusItems(response)
    setVenues(items)
    setLookupStatus((current) => ({ ...current, venues: response.httpStatus < 400 ? 'success' : 'error' }))
  }

  async function loadDateOptions() {
    setLookupStatus((current) => ({ ...current, dateOptions: 'loading' }))
    setDateOptionsCatalog({})

    const results = await Promise.all(
      supportedEventTypes.map(async (eventType) => {
        const response = await requestJson('/date-options', 'GET', undefined, {
          event_type: eventType,
          venue_id: form.venue_id
        })

        return {
          ...response,
          event_type: eventType
        }
      })
    )

    updateResponse('dateOptions', buildDateOptionsResponseSummary(results, form.venue_id))

    const firstSuccessfulPayload = results
      .filter((response) => response.httpStatus < 400)
      .map((response) => getResponseData(response))
      .find((payload) => payload?.server_now)

    if (firstSuccessfulPayload?.server_now) {
      setSearchDates(buildSearchDates(4, firstSuccessfulPayload.server_now))
    }

    const nextCatalog = Object.fromEntries(
      results.map((response) => [
        response.event_type,
        {
          response,
          courts: response.httpStatus < 400 ? normalizeDateOptionCourts(response, form.venue_id) : []
        }
      ])
    )

    setDateOptionsCatalog(nextCatalog)

    const hasAnySuccess = results.some((response) => response.httpStatus < 400)
    if (!hasAnySuccess) {
      setLookupStatus((current) => ({ ...current, dateOptions: 'error' }))
      return
    }

    setLookupStatus((current) => ({ ...current, dateOptions: 'success' }))
  }

  async function loadAvailability() {
    setLookupStatus((current) => ({ ...current, slots: 'loading' }))

    const dateOptionSlots = Object.entries(dateOptionsCatalog).flatMap(([eventType, item]) =>
      buildSlotsFromDateOptions(item.courts || [], {
        event_type: eventType,
        venue_id: form.venue_id,
        tickets_count: form.tickets_count,
        search_dates: searchDates
      })
    )

    const requests = Object.entries(dateOptionsCatalog).flatMap(([eventType, item]) =>
      (item.courts || [])
        .filter((court) => String(getCourtVenueId(court)) === String(form.venue_id))
        .map((court) => ({
          event_type: eventType,
          court_id: court.id,
          court_title: court.title || court.name || `Корт ${court.id}`,
          venue_id: String(getCourtVenueId(court) || form.venue_id)
        }))
    )

    if (!requests.length) {
      setSlots([])
      setSelectedSlotKey('')
      setSelectedSlot(null)
      updateResponse('availability', {
        venue_id: form.venue_id,
        dates: searchDates,
        tickets_count: form.tickets_count,
        requests: []
      })
      setSlots(dateOptionSlots)
      setSelectedSlotKey((current) => (dateOptionSlots.some((slot) => slot.key === current) ? current : dateOptionSlots[0]?.key || ''))
      setLookupStatus((current) => ({ ...current, slots: dateOptionSlots.length ? 'success' : 'error' }))
      return
    }

    const results = await Promise.all(
      searchDates.flatMap((date) =>
        requests.map(async (requestItem) => {
          const response = await requestJson('/availability', 'GET', undefined, {
            event_type: requestItem.event_type,
            venue_id: requestItem.venue_id,
            court_id: requestItem.court_id,
            date
          })

          return {
            ...response,
            ...requestItem,
            date
          }
        })
      )
    )

    updateResponse('availability', buildAvailabilityResponseSummary(results, form.venue_id, searchDates, form.tickets_count))

    const availabilitySlots = results
      .filter((response) => response.httpStatus < 400)
      .flatMap((response) =>
        buildSlots(extractAvailabilityEvents(response), {
          event_type: response.event_type,
          court_id: response.court_id,
          court_title: response.court_title,
          venue_id: response.venue_id,
          tickets_count: form.tickets_count
        })
      )

    const nextSlots = mergeSlots([...dateOptionSlots, ...availabilitySlots])
      .sort((left, right) => new Date(left.starts_at).getTime() - new Date(right.starts_at).getTime())

    setSlots(nextSlots)
    setLookupStatus((current) => ({
      ...current,
      slots: nextSlots.length || results.some((response) => response.httpStatus < 400) ? 'success' : 'error'
    }))

    if (!nextSlots.length) {
      setSelectedSlotKey('')
      setSelectedSlot(null)
      setForm((current) => ({
        ...current,
        event_id: '',
        starts_at: '',
        ends_at: '',
        duration_minutes: ''
      }))
      return
    }

    setSelectedSlotKey((current) => (nextSlots.some((slot) => slot.key === current) ? current : nextSlots[0].key))
  }

  function updateResponse(step, payload) {
    setResponses((current) => ({
      ...current,
      [step]: payload
    }))
  }

  function syncSessionState(data) {
    if (data.session_id) {
      setSessionId(String(data.session_id))
    }

    if (data.hold_id) {
      setHoldId(String(data.hold_id))
    }

    if (data.expires_at) {
      setExpiresAt(data.expires_at)
    }

    if (data.available_tickets_before_hold !== undefined) {
      setAvailableBeforeHold(data.available_tickets_before_hold)
    }

    if (data.available_tickets_after_hold !== undefined) {
      setAvailableAfterHold(data.available_tickets_after_hold)
    }
  }

function checkSessionNotice(payload) {
    const serialized = JSON.stringify(getResponseData(payload))

    if (
      serialized.includes('Registration session is not active') ||
      serialized.includes('Registration session expired')
    ) {
      setNotice('Сессия истекла, повторите цепочку с начала')
    }
  }

  function setValidationNotice(message) {
    setNotice(message)
    return false
  }

  function validateForSession() {
    if (!form.venue_id || !form.court_id || !form.event_type || !form.date) {
      return setValidationNotice('Для создания сессии выберите площадку, корт, формат и дату.')
    }

    return true
  }

  function validateForHold() {
    if (!sessionId || !form.event_id || !form.starts_at || !form.ends_at || !form.duration_minutes || !form.tickets_count) {
      return setValidationNotice('Для удержания слота нужны session_id, event_id, время начала, время окончания, длительность и количество мест.')
    }

    if (manualMode && !isScheduleValid(form.date, form.start_time, form.duration_minutes)) {
      return setValidationNotice('Время должно быть во вторник–воскресенье с 10:00 до 22:00, а длительность должна помещаться в расписание.')
    }

    return true
  }

  function validateForSmsSend() {
    if (!sessionId || !holdId || !form.phone) {
      return setValidationNotice('Для отправки SMS нужны session_id, hold_id и номер телефона.')
    }

    return true
  }

  function validateForSmsVerify() {
    if (!sessionId || !holdId || !form.phone || !smsCode) {
      return setValidationNotice('Для проверки SMS нужны session_id, hold_id, номер телефона и код из SMS.')
    }

    return true
  }

  function validateForConfirm() {
    if (!sessionId || !holdId || !form.first_name || !form.last_name || !form.phone || !form.email) {
      return setValidationNotice('Для подтверждения заполните имя, фамилию, телефон и email.')
    }

    if (!form.privacy_policy_accepted || !form.personal_data_accepted) {
      return setValidationNotice('Для подтверждения нужно принять оба согласия.')
    }

    return true
  }

  async function runStep(stepKey, handler) {
    setLoadingStep(stepKey)
    setNotice('')

    try {
      const response = await handler()
      updateResponse(stepKey, response)
      checkSessionNotice(response)
      return response
    } catch (error) {
      const payload = {
        httpStatus: 500,
        status: 500,
        data: {
          error: 'client_error',
          message: error instanceof Error ? error.message : 'Unknown client error'
        }
      }
      updateResponse(stepKey, payload)
      return payload
    } finally {
      setLoadingStep('')
    }
  }

  async function handleCreateSession() {
    if (!validateForSession()) {
      return
    }

    setHoldId('')
    setExpiresAt('')
    setAvailableBeforeHold(null)
    setAvailableAfterHold(null)
    setVerified(false)
    setSmsCode('')
    setSmsCooldownUntil(null)

    const response = await runStep('session', () =>
      requestJson('/session', 'POST', {
        event_type: form.event_type,
        venue_id: Number(form.venue_id),
        court_id: Number(form.court_id),
        date: form.date
      })
    )

    syncSessionState(getResponseData(response))
  }

  async function handleHold() {
    if (!validateForHold()) {
      return
    }

    const response = await runStep('hold', () =>
      requestJson('/hold', 'PUT', {
        session_id: sessionId,
        event_id: Number(form.event_id),
        starts_at: form.starts_at,
        ends_at: form.ends_at,
        duration_minutes: Number(form.duration_minutes),
        tickets_count: Number(form.tickets_count)
      })
    )

    syncSessionState(getResponseData(response))
  }

  async function handleSmsSend() {
    if (!validateForSmsSend()) {
      return
    }

    const response = await runStep('smsSend', () =>
      requestJson('/sms-send', 'POST', {
        session_id: sessionId,
        hold_id: holdId,
        phone: form.phone
      })
    )

    const data = getResponseData(response)
    syncSessionState(data)

    if (typeof data.retry_after_seconds === 'number' && data.retry_after_seconds > 0) {
      setSmsCooldownUntil(Date.now() + data.retry_after_seconds * 1000)
    }
  }

  async function handleSmsVerify() {
    if (!validateForSmsVerify()) {
      return
    }

    const response = await runStep('smsVerify', () =>
      requestJson('/sms-verify', 'POST', {
        session_id: sessionId,
        hold_id: holdId,
        phone: form.phone,
        code: smsCode,
        otp: smsCode
      })
    )

    const data = getResponseData(response)
    syncSessionState(data)
    setVerified(data.status === 'verified')
  }

  async function handleConfirm() {
    if (!validateForConfirm()) {
      return
    }

    const response = await runStep('confirm', () =>
      requestJson('/confirm', 'POST', {
        session_id: sessionId,
        hold_id: holdId,
        first_name: form.first_name,
        last_name: form.last_name,
        phone: form.phone,
        email: form.email,
        privacy_policy_accepted: form.privacy_policy_accepted,
        personal_data_accepted: form.personal_data_accepted
      })
    )

    syncSessionState(getResponseData(response))
  }

  const discoveredEventTypes = eventTypeOptions.filter((item) => item.slotsCount > 0)
  const discoveredEventTypesText = discoveredEventTypes.length
    ? discoveredEventTypes
        .map((item) => `${item.label}${item.slotsCount ? ` (${item.slotsCount} слот.)` : ''}`)
        .join(', ')
    : 'Не найдены'
  const searchDatesText = searchDates.map((date) => formatDateHuman(date)).join(', ')
  const availableDatesText = availableDateOptions.length
    ? availableDateOptions.map((item) => item.label).join(', ')
    : 'Не найдены'
  const selectedVenueTitle = venueMap.get(String(form.venue_id)) || (form.venue_id ? `Площадка ${form.venue_id}` : '—')
  const selectedCourtTitle = courtMap.get(String(form.court_id)) || (form.court_id ? `Корт ${form.court_id}` : '—')
  const currentEventTitle = getEventTypeLabel(form.event_type, selectedSlot?.event_title)

  return (
    <div className="page">
      <div className="container">
        <header className="hero">
          <div>
            <h1>Помощник регистрации Mos Sport</h1>
            <p>Локальная страница для пошаговой регистрации через API outdoor.sport.mos.ru.</p>
          </div>
          <div className="status-card">
            <div>
              <span className="label">Идентификатор сессии</span>
              <strong>{sessionId || '—'}</strong>
            </div>
            <div>
              <span className="label">Идентификатор hold</span>
              <strong>{holdId || '—'}</strong>
            </div>
            <div>
              <span className="label">Сессия истекает</span>
              <strong>{expiresAt ? formatDateTimeHuman(expiresAt) : '—'}</strong>
            </div>
            <div>
              <span className="label">Обратный отсчёт</span>
              <strong>{expiresInSeconds === null ? '—' : formatRemaining(expiresInSeconds)}</strong>
            </div>
          </div>
        </header>

        {notice ? <div className="notice notice-error">{notice}</div> : null}

        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Параметры записи</h2>
            </div>
            <label className="mode-toggle">
              <input type="checkbox" checked={manualMode} onChange={() => setManualMode((current) => !current)} />
              <span>Ручной режим</span>
            </label>
          </div>

          <div className="grid">
            <label>
              <span>Формат занятия</span>
              <select name="event_type" value={form.event_type} onChange={updateForm}>
                <option value="">{eventTypeOptions.length ? 'Выберите формат' : 'Нет доступных форматов'}</option>
                {eventTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} ({option.slotsCount} слот.)
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{manualMode ? 'Дата' : 'Период поиска'}</span>
              {manualMode ? (
                <input type="date" name="date" value={form.date} onChange={updateForm} />
              ) : (
                <select name="date" value={form.date} onChange={updateForm}>
                  <option value="">{availableDateOptions.length ? 'Выберите дату' : 'Нет доступных дат'}</option>
                  {availableDateOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} ({option.slotsCount} слот.)
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label>
              <span>Площадка</span>
              <select name="venue_id" value={form.venue_id} onChange={updateForm}>
                <option value="">Выберите площадку</option>
                {venues.map((venue) => (
                  <option key={venue.id} value={venue.id}>
                    {venue.title}, {venue.address || 'адрес не указан'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Корт</span>
              {manualCourtMode ? (
                <input
                  type="number"
                  name="court_id"
                  value={form.court_id}
                  onChange={updateForm}
                  min="10"
                  max="14"
                  placeholder="От 10 до 14"
                />
              ) : (
                <select name="court_id" value={form.court_id} onChange={updateForm}>
                  <option value="">{availableCourts.length ? 'Выберите корт' : 'Нет кортов для выбранного формата'}</option>
                  {availableCourts.map((court) => (
                    <option key={court.id} value={court.id}>
                      {court.title || court.name || `Корт ${court.id}`} ({court.slotsCount} слот.)
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label>
              <span>Режим выбора корта</span>
              <select value={manualCourtMode ? 'manual' : 'auto'} onChange={(event) => setManualCourtMode(event.target.value === 'manual')}>
                <option value="auto">Из списка</option>
                <option value="manual">Вручную</option>
              </select>
            </label>
          </div>

          <div className="summary-card">
            <h3>Доступные форматы и корты</h3>
            <div className="summary-grid">
              <div><span>Найденные форматы</span><strong>{discoveredEventTypesText}</strong></div>
              <div><span>Окно поиска</span><strong>{searchDatesText}</strong></div>
              <div><span>Доступные даты</span><strong>{availableDatesText}</strong></div>
              <div><span>Доступные корты</span><strong>{availableCourts.length || '0'}</strong></div>
              <div><span>Режим выбора</span><strong>{manualCourtMode ? 'Ручной court_id' : 'Выбор из date-options'}</strong></div>
              <div><span>Выбранный court_id</span><strong>{form.court_id || '—'}</strong></div>
            </div>
          </div>

          {!manualMode ? (
            <>
              <div className="slot-toolbar">
                <button type="button" onClick={loadAvailability} disabled={!form.venue_id}>
                  Обновить слоты
                </button>
                <span className="slot-status">
                  {lookupStatus.slots === 'loading'
                    ? 'Загрузка доступных слотов по всем форматам, кортам и дням...'
                    : lookupStatus.slots === 'error'
                      ? 'Ошибка загрузки слотов'
                      : visibleSlots.length
                        ? `Найдено доступных слотов: ${visibleSlots.length}`
                        : 'Доступные слоты не найдены'}
                </span>
              </div>

              <div className="grid">
                <label>
                  <span>Доступные слоты</span>
                  <select value={selectedSlotKey} onChange={(event) => setSelectedSlotKey(event.target.value)}>
                    <option value="">Выберите слот</option>
                    {visibleSlots.map((slot) => (
                      <option key={slot.key} value={slot.key}>
                        {formatSlotLabel(slot)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Количество минут для брони</span>
                  <select
                    name="duration_minutes"
                    value={form.duration_minutes}
                    onChange={updateForm}
                    disabled={!selectedSlot}
                  >
                    <option value="">{selectedSlot ? 'Выберите длительность' : 'Сначала выберите время'}</option>
                    {(selectedSlot?.duration_options || []).map((durationOption) => (
                      <option key={durationOption.key} value={durationOption.duration_minutes}>
                        {durationOption.duration_minutes} минут
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Количество мест</span>
                  <input
                    type="number"
                    name="tickets_count"
                    value={form.tickets_count}
                    onChange={updateForm}
                    min="1"
                    max="99"
                    placeholder="Например: 1"
                  />
                </label>
              </div>
            </>
          ) : null}

          {manualMode ? (
            <div className="grid">
              <label>
                <span>Идентификатор площадки</span>
                <input name="venue_id" value={form.venue_id} onChange={updateForm} />
              </label>
              <label>
                <span>Идентификатор корта</span>
                <input name="court_id" value={form.court_id} onChange={updateForm} />
              </label>
              <label>
                <span>Код формата</span>
                <input name="event_type" value={form.event_type} onChange={updateForm} />
              </label>
              <label>
                <span>Время начала</span>
                <input type="time" name="start_time" value={form.start_time} onChange={updateForm} />
              </label>
              <label>
                <span>Идентификатор события</span>
                <input name="event_id" value={form.event_id} onChange={updateForm} />
              </label>
              <label>
                <span>Начало</span>
                <input name="starts_at" value={form.starts_at} onChange={updateForm} />
              </label>
              <label>
                <span>Окончание</span>
                <input name="ends_at" value={form.ends_at} onChange={updateForm} />
              </label>
              <label>
                <span>Длительность, минут</span>
                <input name="duration_minutes" value={form.duration_minutes} onChange={updateForm} />
              </label>
              <label>
                <span>Количество мест</span>
                <input name="tickets_count" value={form.tickets_count} onChange={updateForm} />
              </label>
            </div>
          ) : null}

          <div className="summary-card">
            <h3>Текущая выбранная запись</h3>
            <div className="summary-grid">
              <div><span>Площадка</span><strong>{selectedVenueTitle}</strong></div>
              <div><span>Корт</span><strong>{selectedCourtTitle}</strong></div>
              <div><span>Формат</span><strong>{currentEventTitle}</strong></div>
              <div><span>`venue_id`</span><strong>{form.venue_id || '—'}</strong></div>
              <div><span>`court_id`</span><strong>{form.court_id || '—'}</strong></div>
              <div><span>`event_type`</span><strong>{form.event_type || '—'}</strong></div>
              <div><span>Дата</span><strong>{formatDateHuman(form.date)}</strong></div>
              <div><span>Время</span><strong>{form.starts_at && form.ends_at ? `${formatTimeHuman(form.starts_at)}–${formatTimeHuman(form.ends_at)}` : '—'}</strong></div>
              <div><span>Длительность</span><strong>{form.duration_minutes ? `${form.duration_minutes} минут` : '—'}</strong></div>
              <div><span>Мест</span><strong>{form.tickets_count || '—'}</strong></div>
              <div><span>Событие</span><strong>{form.event_id || '—'}</strong></div>
              <div><span>`starts_at`</span><strong>{form.starts_at || '—'}</strong></div>
              <div><span>`ends_at`</span><strong>{form.ends_at || '—'}</strong></div>
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Данные пользователя</h2>
          <div className="grid">
            <label>
              <span>Имя</span>
              <input name="first_name" value={form.first_name} onChange={updateForm} placeholder="Например: Иван" />
            </label>
            <label>
              <span>Фамилия</span>
              <input name="last_name" value={form.last_name} onChange={updateForm} placeholder="Например: Иванов" />
            </label>
            <label>
              <span>Телефон</span>
              <input name="phone" value={form.phone} onChange={updateForm} placeholder="+79991234567" />
            </label>
            <label>
              <span>Email</span>
              <input name="email" value={form.email} onChange={updateForm} placeholder="name@example.com" />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                name="privacy_policy_accepted"
                checked={form.privacy_policy_accepted}
                onChange={updateForm}
              />
              <span>Согласие с политикой конфиденциальности</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                name="personal_data_accepted"
                checked={form.personal_data_accepted}
                onChange={updateForm}
              />
              <span>Согласие на обработку персональных данных</span>
            </label>
          </div>
        </section>

        <section className="panel">
          <h2>Шаги</h2>
          <div className="actions">
            <button type="button" onClick={handleCreateSession} disabled={loadingStep === 'session'}>
              {loadingStep === 'session' ? 'Создание...' : '1. Создать сессию'}
            </button>
            <button type="button" onClick={handleHold} disabled={!sessionId || loadingStep === 'hold'}>
              {loadingStep === 'hold' ? 'Удержание...' : '2. Удержать слот'}
            </button>
            <button
              type="button"
              onClick={handleSmsSend}
              disabled={!sessionId || !holdId || smsRetryInSeconds > 0 || loadingStep === 'smsSend'}
            >
              {loadingStep === 'smsSend'
                ? 'Отправка...'
                : smsRetryInSeconds > 0
                  ? `3. Повтор через ${smsRetryInSeconds} с`
                  : '3. Отправить SMS'}
            </button>
          </div>

          <div className="verify-row">
            <label className="sms-code">
              <span>SMS-код</span>
              <input value={smsCode} onChange={(event) => setSmsCode(event.target.value)} placeholder="Введите код" />
            </label>
            <button
              type="button"
              onClick={handleSmsVerify}
              disabled={!sessionId || !holdId || !smsCode || loadingStep === 'smsVerify'}
            >
              {loadingStep === 'smsVerify' ? 'Проверка...' : '4. Проверить код'}
            </button>
            <button
              type="button"
              className="confirm"
              onClick={handleConfirm}
              disabled={!verified || loadingStep === 'confirm'}
            >
              {loadingStep === 'confirm' ? 'Подтверждение...' : '5. Подтвердить запись'}
            </button>
          </div>

          <div className="meta">
            <div>SMS подтверждён: <strong>{verified ? 'да' : 'нет'}</strong></div>
            <div>Мест до hold: <strong>{availableBeforeHold ?? '—'}</strong></div>
            <div>Мест после hold: <strong>{availableAfterHold ?? '—'}</strong></div>
          </div>
        </section>

        <section className="responses">
          <ResponseBlock title="Слоты из availability" payload={responses.availability} />
          <ResponseBlock title="1. Создание сессии" payload={responses.session} />
          <ResponseBlock title="2. Удержание слота" payload={responses.hold} />
          <ResponseBlock title="3. Отправка SMS" payload={responses.smsSend} />
          <ResponseBlock title="4. Проверка SMS" payload={responses.smsVerify} />
          <ResponseBlock title="5. Подтверждение записи" payload={responses.confirm} />
        </section>
      </div>
    </div>
  )
}

function ResponseBlock({ title, payload }) {
  return (
    <article className="response-card">
      <div className="response-header">
        <h3>{title}</h3>
        <span>{payload ? `HTTP ${payload.httpStatus}` : 'Нет данных'}</span>
      </div>
      <pre>{payload ? JSON.stringify(payload, null, 2) : 'Ожидание запроса...'}</pre>
    </article>
  )
}
