import { DEFAULT_NOTIFY_MODES, MAX_ALERT_DATE, MONITOR_INTERVAL_MS, SUPPORTED_MONITOR_EVENT_TYPES, VENUES } from '../config'
import { deactivateSubscription, listActiveSubscriptions, updateSubscriptionDelivery } from '../db'
import { MonitorSlot, Subscription } from '../types'
import { addDaysYmd, buildSearchDates, formatDateHuman, formatDateTimeHuman, getCurrentMskContext } from '../utils/date'
import { buildHash } from '../utils/hash'
import { getEventTypeLabel } from '../utils/domain'
import {
  fetchAvailabilityForMonitor,
  fetchDateOptionsForMonitor,
  mergeSlots,
  normalizeAvailabilitySlots,
  normalizeDateOptionSlots
} from './outdoor'
import { sendTelegramMessage } from './telegram'

let monitorLoopStarted = false
let monitorInProgress = false

function normalizeNotifyModes(modes: readonly string[]): string[] {
  return Array.from(new Set(['ready', ...modes.map(String)]))
}

function buildMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: 'Меню', callback_data: 'menu_new|home' }]]
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function matchesSubscription(slot: MonitorSlot, subscription: Subscription): boolean {
  if (!subscription.venues.includes(String(slot.venue_id))) {
    return false
  }

  if (!subscription.event_types.includes(String(slot.event_type))) {
    return false
  }

  if (!subscription.durations.includes(Number(slot.duration_minutes))) {
    return false
  }

  if (subscription.date_filter && subscription.date_filter !== slot.event_date) {
    return false
  }

  if ((Number(slot.raw_available_tickets) || 0) < (Number(subscription.min_raw_tickets) || 1)) {
    return false
  }

  const modes = new Set(normalizeNotifyModes(subscription.notify_modes.length ? subscription.notify_modes : DEFAULT_NOTIFY_MODES))
  if (modes.has('api_visible')) {
    return true
  }
  if (modes.has('disabled_visible') && slot.booking_open === true && slot.enabled === false) {
    return true
  }
  if (modes.has('ready') && slot.booking_open === true && slot.enabled === true) {
    return true
  }

  return false
}

function renderSlotLine(slot: MonitorSlot, ticketsCount: number): string {
  return [
    `- ${escapeHtml(formatDateTimeHuman(slot.starts_at))}`,
    `${escapeHtml(getEventTypeLabel(slot.event_type))} — ${slot.duration_minutes} мин`,
    `${escapeHtml(slot.venue_title)}, ${escapeHtml(slot.court_title)}`,
    `Доступно ${ticketsCount} билетов`
  ].join(' | ')
}

function isDisabledVisibleSlot(slot: MonitorSlot): boolean {
  return slot.booking_open === true && slot.enabled === false
}

function isReadySlot(slot: MonitorSlot): boolean {
  return slot.booking_open === true && slot.enabled === true
}

function renderSection(title: string, slots: MonitorSlot[], ticketsSelector: (slot: MonitorSlot) => number): string {
  if (!slots.length) {
    return ''
  }

  return [`<b>${escapeHtml(title)}</b>`, ...slots.map((slot) => renderSlotLine(slot, ticketsSelector(slot)))].join('\n')
}

function subscriptionSummary(subscription: Subscription): string {
  return [
    `Площадки: ${subscription.venues.join(', ')}`,
    `Форматы: ${subscription.event_types.map(getEventTypeLabel).join(', ')}`,
    `Длительность: ${subscription.durations.map((item) => `${item} мин`).join(', ')}`,
    `Мин. билетов (raw): ${subscription.min_raw_tickets}`,
    `Дата: ${subscription.date_filter ? formatDateHuman(subscription.date_filter) : '—'}`
  ].join('\n')
}

function renderAlertText(subscription: Subscription, slots: MonitorSlot[]): string {
  const notifyModes = new Set(normalizeNotifyModes(subscription.notify_modes))
  const sections: string[] = [
    `<b>Найдены слоты по подписке #${subscription.id}</b>`,
    escapeHtml(subscriptionSummary(subscription))
  ]

  if (notifyModes.has('api_visible')) {
    const apiSlots = [...slots]
    if (apiSlots.length) {
      sections.push('', renderSection('Есть в API:', apiSlots, (slot) => Number(slot.raw_available_tickets) || Number(slot.available_tickets) || 0))
    }
  }

  if (notifyModes.has('disabled_visible')) {
    const disabledSlots = slots.filter(isDisabledVisibleSlot)
    if (disabledSlots.length) {
      sections.push('', renderSection('Появилось в брони на сайте:', disabledSlots, (slot) => Number(slot.available_tickets) || Number(slot.raw_available_tickets) || 0))
    }
  }

  const readySlots = slots.filter(isReadySlot)
  if (readySlots.length) {
    sections.push('', renderSection('Доступно для брони на сайте:', readySlots, (slot) => Number(slot.available_tickets) || Number(slot.raw_available_tickets) || 0))
  }

  sections.push(
    '',
    'Можно попробовать записаться <a href="https://aeroserg.github.io/mos-sport/">в помощнике записи</a>, когда слот уже есть в API или виден на сайте, но ещё не выбирается.',
    'Когда слот уже доступен для записи на сайте, можно идти и через <a href="https://outdoor.sport.mos.ru/#venues-events">официальный сайт Mos Sport</a>.'
  )

  return sections.join('\n')
}

async function expireFinishedSubscriptions(): Promise<void> {
  const subscriptions = listActiveSubscriptions()
  const current = getCurrentMskContext()

  for (const subscription of subscriptions) {
    if (!subscription.date_filter) {
      continue
    }

    if (subscription.date_filter < current.date || (subscription.date_filter === current.date && current.hour >= 22)) {
      deactivateSubscription(subscription.id, 'date_finished')
      await sendTelegramMessage(
        subscription.chat_id,
        `Подписка #${subscription.id} на ${formatDateHuman(subscription.date_filter)} отключена: день закончился.`,
        buildMenuKeyboard()
      )
    }
  }
}

export async function runMonitorTick(): Promise<void> {
  if (monitorInProgress) {
    return
  }

  monitorInProgress = true

  try {
    await expireFinishedSubscriptions()
    const subscriptions = listActiveSubscriptions()
    if (!subscriptions.length) {
      return
    }

    const venueIds = Array.from(new Set(subscriptions.flatMap((item) => item.venues.map(String))))
    const eventTypes = Array.from(
      new Set(subscriptions.flatMap((item) => item.event_types.map(String)).filter((value) => SUPPORTED_MONITOR_EVENT_TYPES.includes(value as 'free_play' | 'masterclass')))
    )

    const dateOptionsResults = await Promise.all(
      venueIds.flatMap((venueId) => eventTypes.map((eventType) => fetchDateOptionsForMonitor(venueId, eventType)))
    )

    const serverNow =
      dateOptionsResults.find((item) => item.status < 400 && item.body?.server_now)?.body?.server_now || new Date().toISOString()
    const openWindowDates = new Set(buildSearchDates(3, serverNow))

    const dateOptionSlots = dateOptionsResults
      .filter((item) => item.status < 400)
      .flatMap((item) => normalizeDateOptionSlots(item.body))

    const availabilityQueries = Array.from(
      new Set(
        subscriptions.flatMap((subscription) =>
          subscription.venues.flatMap((venueId) =>
            subscription.event_types.flatMap((eventType) =>
              VENUES[String(venueId) as keyof typeof VENUES].courts.map((courtId) =>
                [venueId, courtId, eventType, subscription.date_filter].join('|')
              )
            )
          )
        )
      )
    ).map((key) => {
      const [venueId, courtId, eventType, date] = key.split('|')
      return { venueId, courtId, eventType, date }
    })

    const availabilityResults = await Promise.all(
      availabilityQueries.map((query) =>
        fetchAvailabilityForMonitor(query.venueId, query.courtId, query.eventType, query.date)
      )
    )

    const availabilitySlots = availabilityResults
      .filter((item) => item.status < 400)
      .flatMap((item) =>
        normalizeAvailabilitySlots(item.body, {
          venue_id: item.venue_id,
          court_id: item.court_id,
          event_type: item.event_type,
          date: item.date
        })
      )

    const allSlots = mergeSlots([...dateOptionSlots, ...availabilitySlots]).filter((slot) => slot.event_date && slot.event_date <= MAX_ALERT_DATE)

    for (const subscription of subscriptions) {
      const matchingSlots = allSlots.filter((slot) => {
        if (!matchesSubscription(slot, subscription)) {
          return false
        }

        if (!subscription.notify_modes.includes('api_visible') && !subscription.notify_modes.includes('disabled_visible')) {
          if (slot.event_date > addDaysYmd(getCurrentMskContext().date, 2) && !openWindowDates.has(slot.event_date) && slot.booking_open !== true) {
            return false
          }
        }

        return true
      })

      if (!matchingSlots.length) {
        continue
      }

      const text = renderAlertText(subscription, matchingSlots)
      const fingerprint = buildHash(text)
      if (subscription.last_sent_fingerprint === fingerprint) {
        continue
      }

      await sendTelegramMessage(subscription.chat_id, text, buildMenuKeyboard())
      updateSubscriptionDelivery(subscription.id, fingerprint, text)
    }
  } catch (error) {
    console.error('Monitor tick failed:', error)
  } finally {
    monitorInProgress = false
  }
}

export async function startMonitorLoop(): Promise<void> {
  if (monitorLoopStarted) {
    return
  }

  monitorLoopStarted = true
  await runMonitorTick()
  setInterval(() => {
    void runMonitorTick()
  }, MONITOR_INTERVAL_MS)
}
