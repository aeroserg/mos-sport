const crypto = require('crypto')
const express = require('express')
const Database = require('better-sqlite3')

const PORT = Number(process.env.PORT) || 4003
const API_BASE_URL = process.env.OUTDOOR_API_BASE_URL || 'https://api.outdoor.sport.mos.ru'
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
const SQLITE_PATH = process.env.SQLITE_PATH || '/data/mos-sport.sqlite'
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : ''
const TELEGRAM_POLL_TIMEOUT_SECONDS = 25
const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 30000
const TIMEZONE = 'Europe/Moscow'
const MAX_ALERT_DATE = '2026-09-30'
const SUPPORTED_MONITOR_EVENT_TYPES = ['free_play', 'masterclass']
const EVENT_TYPE_LABELS = {
  free_play: 'Свободная игра',
  masterclass: 'Мастер-класс'
}
const DURATION_OPTIONS = [30, 60, 90, 120, 180]
const DEFAULT_NOTIFY_MODES = ['ready']
const VENUES = {
  '12': {
    id: 12,
    title: 'Баррикадная',
    courts: [10, 11]
  },
  '14': {
    id: 14,
    title: 'Третьяковская',
    courts: [12, 13]
  },
  '15': {
    id: 15,
    title: 'Римская',
    courts: [14, 15]
  }
}
const COMMON_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  'cache-control': 'no-cache',
  'content-type': 'application/json',
  origin: 'https://outdoor.sport.mos.ru',
  pragma: 'no-cache',
  referer: 'https://outdoor.sport.mos.ru/',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
}
const VENUES_QUERY =
  'filter[status][_eq]=published&sort=sort&fields=id,title,image,address,working_hours,sort,status,tags.id,tags.venues_id,tags.tags_id.id,tags.tags_id.name'

const MONTHS = {
  январь: 1,
  января: 1,
  январе: 1,
  jan: 1,
  февраль: 2,
  февраля: 2,
  феврале: 2,
  март: 3,
  марта: 3,
  марте: 3,
  апрель: 4,
  апреля: 4,
  апреле: 4,
  май: 5,
  мая: 5,
  мае: 5,
  июнь: 6,
  июня: 6,
  июне: 6,
  июль: 7,
  июля: 7,
  июле: 7,
  август: 8,
  августа: 8,
  августе: 8,
  сентябрь: 9,
  сентября: 9,
  сентябре: 9,
  октябрь: 10,
  октября: 10,
  октябре: 10,
  ноябрь: 11,
  ноября: 11,
  ноябре: 11,
  декабрь: 12,
  декабря: 12,
  декабре: 12
}

const db = new Database(SQLITE_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    venues_json TEXT NOT NULL,
    event_types_json TEXT NOT NULL,
    durations_json TEXT NOT NULL,
    min_raw_tickets INTEGER NOT NULL,
    date_filter TEXT NOT NULL,
    notify_modes_json TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_fingerprint TEXT,
    last_sent_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_states (
    chat_id TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`)

const statements = {
  upsertUser: db.prepare(`
    INSERT INTO users (chat_id, username, first_name, last_name, created_at, updated_at)
    VALUES (@chat_id, @username, @first_name, @last_name, @created_at, @updated_at)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `),
  getState: db.prepare('SELECT state_json FROM user_states WHERE chat_id = ?'),
  setState: db.prepare(`
    INSERT INTO user_states (chat_id, state_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `),
  clearState: db.prepare('DELETE FROM user_states WHERE chat_id = ?'),
  createSubscription: db.prepare(`
    INSERT INTO subscriptions (
      chat_id,
      venues_json,
      event_types_json,
      durations_json,
      min_raw_tickets,
      date_filter,
      notify_modes_json,
      active,
      last_sent_fingerprint,
      last_sent_text,
      created_at,
      updated_at
    ) VALUES (
      @chat_id,
      @venues_json,
      @event_types_json,
      @durations_json,
      @min_raw_tickets,
      @date_filter,
      @notify_modes_json,
      1,
      NULL,
      NULL,
      @created_at,
      @updated_at
    )
  `),
  listSubscriptionsByChat: db.prepare(`
    SELECT *
    FROM subscriptions
    WHERE chat_id = ?
    ORDER BY active DESC, created_at DESC, id DESC
  `),
  listActiveSubscriptions: db.prepare(`
    SELECT *
    FROM subscriptions
    WHERE active = 1
    ORDER BY id ASC
  `),
  deactivateSubscription: db.prepare(`
    UPDATE subscriptions
    SET active = 0, updated_at = ?
    WHERE id = ?
  `),
  deactivateSubscriptionForChat: db.prepare(`
    UPDATE subscriptions
    SET active = 0, updated_at = ?
    WHERE id = ? AND chat_id = ?
  `),
  updateSubscriptionDelivery: db.prepare(`
    UPDATE subscriptions
    SET last_sent_fingerprint = ?, last_sent_text = ?, updated_at = ?
    WHERE id = ?
  `),
  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare(`
    INSERT INTO kv (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `)
}

let telegramLoopStarted = false
let monitorLoopStarted = false
let monitorInProgress = false

function nowIso() {
  return new Date().toISOString()
}

function normalizeQueryValue(value) {
  if (value === undefined || value === null) {
    return ''
  }

  return String(value)
}

function buildQueryString(query) {
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

function formatYmdParts(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function getMskDateParts(value = new Date()) {
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
  const result = {}

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

function getCurrentMskContext() {
  const parts = getMskDateParts()
  return {
    ...parts,
    date: formatYmdParts(parts.year, parts.month, parts.day)
  }
}

function formatDateHuman(date) {
  if (!date) {
    return '—'
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: TIMEZONE
  }).format(new Date(`${date}T00:00:00+03:00`))
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
    minute: '2-digit',
    timeZone: TIMEZONE
  }).format(new Date(value))
}

function buildSearchDates(daysCount = 3, startValue) {
  const startParts = startValue ? getMskDateParts(startValue) : getCurrentMskContext()
  const startDate = new Date(`${formatYmdParts(startParts.year, startParts.month, startParts.day)}T00:00:00+03:00`)
  const dates = []

  for (let index = 0; index < daysCount; index += 1) {
    const nextDate = new Date(startDate)
    nextDate.setUTCDate(startDate.getUTCDate() + index)
    const nextParts = getMskDateParts(nextDate)
    dates.push(formatYmdParts(nextParts.year, nextParts.month, nextParts.day))
  }

  return dates
}

function addDaysYmd(date, days) {
  const base = new Date(`${date}T00:00:00+03:00`)
  base.setUTCDate(base.getUTCDate() + days)
  const parts = getMskDateParts(base)
  return formatYmdParts(parts.year, parts.month, parts.day)
}

function daysBetweenYmd(left, right) {
  const leftDate = new Date(`${left}T00:00:00+03:00`).getTime()
  const rightDate = new Date(`${right}T00:00:00+03:00`).getTime()
  return Math.round((rightDate - leftDate) / 86400000)
}

function isValidYmd(date) {
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

function parseFlexibleDateInput(input) {
  const current = getCurrentMskContext()
  const normalized = String(input || '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) {
    return { ok: false, error: 'Дата не указана.' }
  }

  const candidates = []

  let match = normalized.match(/^(\d{4})[.\-/ ](\d{1,2})[.\-/ ](\d{1,2})$/)
  if (match) {
    candidates.push({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    })
  }

  match = normalized.match(/^(\d{1,2})[.\-/ ](\d{1,2})(?:[.\-/ ](\d{2,4}))?$/)
  if (match) {
    candidates.push({
      day: Number(match[1]),
      month: Number(match[2]),
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  match = normalized.match(/^(\d{1,2})$/)
  if (match) {
    candidates.push({
      day: Number(match[1]),
      month: current.month,
      year: current.year
    })
  }

  match = normalized.match(/^(\d{1,2})\s+([а-яё]+)(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[2]]) {
    candidates.push({
      day: Number(match[1]),
      month: MONTHS[match[2]],
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  match = normalized.match(/^([а-яё]+)\s+(\d{1,2})(?:\s+(\d{4}))?$/)
  if (match && MONTHS[match[1]]) {
    candidates.push({
      day: Number(match[2]),
      month: MONTHS[match[1]],
      year: match[3] ? Number(match[3]) : current.year
    })
  }

  for (const candidate of candidates) {
    const year = candidate.year
    const month = candidate.month
    const day = candidate.day

    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      continue
    }

    const formatted = formatYmdParts(year, month, day)
    if (!isValidYmd(formatted)) {
      continue
    }

    if (formatted < current.date) {
      return { ok: false, error: 'Нельзя подписаться на прошедшую дату.' }
    }

    if (formatted > MAX_ALERT_DATE) {
      return { ok: false, error: `Дата должна быть не позже ${formatDateHuman(MAX_ALERT_DATE)}.` }
    }

    return {
      ok: true,
      date: formatted,
      requiresFutureModeChoice: daysBetweenYmd(current.date, formatted) > 2
    }
  }

  return {
    ok: false,
    error: 'Не понял дату. Поддерживаются форматы: 26, 26.07, 26/07/2026, 2026-07-26, 26 июля.'
  }
}

function getEventTypeLabel(eventType) {
  return EVENT_TYPE_LABELS[eventType] || eventType
}

function getVenueLabel(venueId) {
  return VENUES[String(venueId)]?.title || `Площадка ${venueId}`
}

function getCourtLabel(venueId, courtId) {
  const venue = VENUES[String(venueId)]
  if (!venue) {
    return `Корт ${courtId}`
  }

  const index = venue.courts.findIndex((item) => String(item) === String(courtId))
  return index >= 0 ? `Корт ${index + 1}` : `Корт ${courtId}`
}

function jsonParseArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function buildHash(value) {
  return crypto.createHash('sha1').update(value).digest('hex')
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

async function callOutdoorApi(endpoint, method, body) {
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

async function fetchOutdoorJson(endpoint, method = 'GET', body) {
  const result = await callOutdoorApi(endpoint, method, body)
  return result.isJson ? result.body : { raw_text: result.body }
}

function sendUpstreamResult(res, result) {
  if (result.isJson) {
    res.status(result.status).json(result.body)
    return
  }

  res.status(result.status).send(result.body)
}

function saveUser(telegramUser) {
  if (!telegramUser?.id) {
    return
  }

  const timestamp = nowIso()
  statements.upsertUser.run({
    chat_id: String(telegramUser.id),
    username: telegramUser.username || '',
    first_name: telegramUser.first_name || '',
    last_name: telegramUser.last_name || '',
    created_at: timestamp,
    updated_at: timestamp
  })
}

function getState(chatId) {
  const row = statements.getState.get(String(chatId))
  if (!row) {
    return null
  }

  try {
    return JSON.parse(row.state_json)
  } catch {
    return null
  }
}

function setState(chatId, state) {
  statements.setState.run(String(chatId), JSON.stringify(state), nowIso())
}

function clearState(chatId) {
  statements.clearState.run(String(chatId))
}

function getKv(key) {
  const row = statements.getKv.get(key)
  return row?.value || ''
}

function setKv(key, value) {
  statements.setKv.run(key, String(value), nowIso())
}

function normalizeSubscriptionRow(row) {
  return {
    id: row.id,
    chat_id: row.chat_id,
    venues: jsonParseArray(row.venues_json).map(String),
    event_types: jsonParseArray(row.event_types_json).map(String),
    durations: jsonParseArray(row.durations_json).map(Number),
    min_raw_tickets: Number(row.min_raw_tickets) || 1,
    date_filter: row.date_filter,
    notify_modes: jsonParseArray(row.notify_modes_json).map(String),
    active: Boolean(row.active),
    last_sent_fingerprint: row.last_sent_fingerprint || '',
    last_sent_text: row.last_sent_text || '',
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function listSubscriptionsByChat(chatId) {
  return statements.listSubscriptionsByChat.all(String(chatId)).map(normalizeSubscriptionRow)
}

function listActiveSubscriptions() {
  return statements.listActiveSubscriptions.all().map(normalizeSubscriptionRow)
}

function createSubscription(subscription) {
  const timestamp = nowIso()
  const result = statements.createSubscription.run({
    chat_id: String(subscription.chat_id),
    venues_json: JSON.stringify(subscription.venues),
    event_types_json: JSON.stringify(subscription.event_types),
    durations_json: JSON.stringify(subscription.durations),
    min_raw_tickets: Number(subscription.min_raw_tickets) || 1,
    date_filter: subscription.date_filter,
    notify_modes_json: JSON.stringify(subscription.notify_modes),
    created_at: timestamp,
    updated_at: timestamp
  })

  return Number(result.lastInsertRowid)
}

function deactivateSubscription(id) {
  statements.deactivateSubscription.run(nowIso(), Number(id))
}

function deactivateSubscriptionForChat(id, chatId) {
  statements.deactivateSubscriptionForChat.run(nowIso(), Number(id), String(chatId))
}

function updateSubscriptionDelivery(id, fingerprint, text) {
  statements.updateSubscriptionDelivery.run(fingerprint, text, nowIso(), Number(id))
}

function createInitialWizardState(messageId) {
  return {
    flow: 'subscription',
    step: 'venues',
    history: [],
    message_id: messageId || null,
    data: {
      venues: [],
      event_types: [],
      durations: [],
      min_raw_tickets: 1,
      date_filter: '',
      notify_modes: [...DEFAULT_NOTIFY_MODES]
    }
  }
}

function pushHistory(state) {
  return {
    ...state,
    history: [...(state.history || []), state.step]
  }
}

function popHistory(state) {
  const history = [...(state.history || [])]
  const previous = history.pop()
  return {
    ...state,
    history,
    step: previous || 'venues'
  }
}

function subscriptionSummary(subscriptionData) {
  const venuesText = subscriptionData.venues.map(getVenueLabel).join(', ')
  const eventTypesText = subscriptionData.event_types.map(getEventTypeLabel).join(', ')
  const durationsText = subscriptionData.durations.map((item) => `${item} мин`).join(', ')
  const notifyModesText = formatNotifyModes(subscriptionData.notify_modes)

  return [
    `Площадки: ${venuesText || '—'}`,
    `Форматы: ${eventTypesText || '—'}`,
    `Длительность: ${durationsText || '—'}`,
    `Мин. билетов (raw): ${subscriptionData.min_raw_tickets || '—'}`,
    `Дата: ${subscriptionData.date_filter ? formatDateHuman(subscriptionData.date_filter) : '—'}`,
    `Когда уведомлять: ${notifyModesText}`
  ].join('\n')
}

function formatNotifyModes(modes) {
  const normalized = new Set((modes || []).map(String))
  const labels = []

  if (normalized.has('ready')) {
    labels.push('когда можно бронировать')
  }
  if (normalized.has('api_visible')) {
    labels.push('когда слот появился в API')
  }
  if (normalized.has('disabled_visible')) {
    labels.push('когда слот серый / выключен')
  }

  return labels.join(', ') || 'когда можно бронировать'
}

function button(text, data) {
  return { text, callback_data: data }
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [button('Подписаться на обновления', 'menu|subscribe')],
      [button('Мои подписки', 'menu|list')],
      [button('Отписаться', 'menu|unsubscribe')]
    ]
  }
}

function buildStepKeyboard(state) {
  const data = state.data

  if (state.step === 'venues') {
    const selected = new Set(data.venues.map(String))
    const rows = Object.values(VENUES)
      .filter((venue) => !selected.has(String(venue.id)))
      .map((venue) => [button(venue.title, `sub|venues|add|${venue.id}`)])

    rows.push([button('Все площадки', 'sub|venues|all')])
    if (selected.size > 0) {
      rows.push([button('Готово', 'sub|venues|done')])
    }
    rows.push([button('Отмена', 'sub|cancel')])
    return { inline_keyboard: rows }
  }

  if (state.step === 'event_types') {
    const selected = new Set(data.event_types.map(String))
    const rows = SUPPORTED_MONITOR_EVENT_TYPES
      .filter((eventType) => !selected.has(String(eventType)))
      .map((eventType) => [button(getEventTypeLabel(eventType), `sub|event_types|add|${eventType}`)])

    rows.push([button('Все форматы', 'sub|event_types|all')])
    if (selected.size > 0) {
      rows.push([button('Готово', 'sub|event_types|done')])
    }
    rows.push([button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')])
    return { inline_keyboard: rows }
  }

  if (state.step === 'durations') {
    const selected = new Set(data.durations.map(Number))
    const rows = DURATION_OPTIONS
      .filter((duration) => !selected.has(Number(duration)))
      .map((duration) => [button(`${duration} минут`, `sub|durations|add|${duration}`)])

    rows.push([button('Все длительности', 'sub|durations|all')])
    if (selected.size > 0) {
      rows.push([button('Готово', 'sub|durations|done')])
    }
    rows.push([button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')])
    return { inline_keyboard: rows }
  }

  if (state.step === 'tickets') {
    return {
      inline_keyboard: [
        [1, 2].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [3, 4].map((value) => button(`${value}`, `sub|tickets|set|${value}`)),
        [button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')]
      ]
    }
  }

  if (state.step === 'date_input') {
    return {
      inline_keyboard: [[button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')]]
    }
  }

  if (state.step === 'notify_modes') {
    const selected = new Set((data.notify_modes || []).map(String))
    const rows = []

    if (!selected.has('api_visible')) {
      rows.push([button('Когда слот появился в API', 'sub|notify|add|api_visible')])
    }
    if (!selected.has('disabled_visible')) {
      rows.push([button('Когда слот серый / выключен', 'sub|notify|add|disabled_visible')])
    }
    rows.push([button('Не надо, только когда можно бронировать', 'sub|notify|default')])
    rows.push([button('Сохранить подписку', 'sub|notify|done')])
    rows.push([button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')])
    return { inline_keyboard: rows }
  }

  return buildMainMenuKeyboard()
}

function buildStepText(state) {
  const data = state.data

  if (state.step === 'venues') {
    return [
      'Шаг 1 из 6',
      'Выберите площадки для подписки.',
      '',
      `Сейчас выбрано: ${data.venues.length ? data.venues.map(getVenueLabel).join(', ') : 'ничего'}`
    ].join('\n')
  }

  if (state.step === 'event_types') {
    return [
      'Шаг 2 из 6',
      'Выберите форматы.',
      '',
      `Сейчас выбрано: ${data.event_types.length ? data.event_types.map(getEventTypeLabel).join(', ') : 'ничего'}`
    ].join('\n')
  }

  if (state.step === 'durations') {
    return [
      'Шаг 3 из 6',
      'Выберите длительность сеансов.',
      '',
      `Сейчас выбрано: ${data.durations.length ? data.durations.map((item) => `${item} мин`).join(', ') : 'ничего'}`
    ].join('\n')
  }

  if (state.step === 'tickets') {
    return [
      'Шаг 4 из 6',
      'Выберите минимальное количество билетов по `raw_available_tickets`.',
      'Обычно реально доступны 1–4 билета. Если поставить 4, уведомления могут приходить редко.'
    ].join('\n')
  }

  if (state.step === 'date_input') {
    return [
      'Шаг 5 из 6',
      'Отправьте дату сообщением.',
      'Поддерживаются форматы: `26`, `26.07`, `26/07/2026`, `2026-07-26`, `26 июля`.',
      `Дата должна быть между сегодня и ${formatDateHuman(MAX_ALERT_DATE)}.`
    ].join('\n')
  }

  if (state.step === 'notify_modes') {
    const currentDate = getCurrentMskContext().date
    const isFutureBeyondOpenWindow = data.date_filter && daysBetweenYmd(currentDate, data.date_filter) > 2
    const warning = isFutureBeyondOpenWindow
      ? 'Дата дальше ближайших 3 дней. По умолчанию уведомление придёт только когда слот реально станет доступен для записи.'
      : 'По умолчанию уведомление придёт только когда слот реально можно бронировать.'

    return [
      'Шаг 6 из 6',
      warning,
      '',
      subscriptionSummary(data)
    ].join('\n')
  }

  return 'Меню'
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_API_BASE) {
    return { ok: false, error: 'telegram_disabled' }
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    })
    return await response.json()
  } catch (error) {
    console.error(`Telegram API error for ${method}:`, error)
    return { ok: false, error: error instanceof Error ? error.message : 'unknown_telegram_error' }
  }
}

async function sendTelegramMessage(chatId, text, replyMarkup) {
  const result = await telegramApi('sendMessage', {
    chat_id: String(chatId),
    text,
    reply_markup: replyMarkup,
    disable_web_page_preview: true
  })

  return result.ok ? result.result : null
}

async function editTelegramMessage(chatId, messageId, text, replyMarkup) {
  const result = await telegramApi('editMessageText', {
    chat_id: String(chatId),
    message_id: Number(messageId),
    text,
    reply_markup: replyMarkup,
    disable_web_page_preview: true
  })

  if (!result.ok && !String(result.description || '').includes('message is not modified')) {
    console.error('Failed to edit Telegram message:', result)
  }

  return result.ok ? result.result : null
}

async function answerCallbackQuery(callbackQueryId, text) {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text || undefined,
    show_alert: false
  })
}

async function renderMenu(chatId, messageId) {
  const text = [
    'Бот слежения за слотами Mos Sport.',
    '',
    'Можно подписаться на площадки, форматы, длительности, дату и минимальное количество билетов.'
  ].join('\n')

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, buildMainMenuKeyboard())
    return messageId
  }

  const message = await sendTelegramMessage(chatId, text, buildMainMenuKeyboard())
  return message?.message_id || null
}

async function renderWizard(chatId, state, messageId) {
  const nextState = {
    ...state,
    message_id: messageId || state.message_id || null
  }
  const text = buildStepText(nextState)
  const keyboard = buildStepKeyboard(nextState)

  let currentMessageId = nextState.message_id
  if (currentMessageId) {
    await editTelegramMessage(chatId, currentMessageId, text, keyboard)
  } else {
    const message = await sendTelegramMessage(chatId, text, keyboard)
    currentMessageId = message?.message_id || null
  }

  setState(chatId, {
    ...nextState,
    message_id: currentMessageId
  })
}

async function renderSubscriptionsList(chatId, messageId, mode = 'list') {
  const subscriptions = listSubscriptionsByChat(chatId)

  if (!subscriptions.length) {
    const text = 'Подписок пока нет.'
    if (messageId) {
      await editTelegramMessage(chatId, messageId, text, {
        inline_keyboard: [[button('Назад в меню', 'menu|home')]]
      })
      return
    }

    await sendTelegramMessage(chatId, text, {
      inline_keyboard: [[button('Назад в меню', 'menu|home')]]
    })
    return
  }

  const text = subscriptions
    .map((subscription) => {
      const status = subscription.active ? 'активна' : 'выключена'
      return [`#${subscription.id} — ${status}`, subscriptionSummary(subscription)].join('\n')
    })
    .join('\n\n')

  const rows = subscriptions
    .filter((subscription) => (mode === 'unsubscribe' ? subscription.active : true))
    .map((subscription) => [
      button(
        mode === 'unsubscribe' ? `Отключить #${subscription.id}` : `Подписка #${subscription.id}`,
        mode === 'unsubscribe' ? `unsub|${subscription.id}` : 'noop|list'
      )
    ])

  rows.push([button('Назад в меню', 'menu|home')])

  if (messageId) {
    await editTelegramMessage(chatId, messageId, text, { inline_keyboard: rows })
    return
  }

  await sendTelegramMessage(chatId, text, { inline_keyboard: rows })
}

function createSlotKey(slot) {
  return [
    slot.venue_id,
    slot.court_id,
    slot.event_type,
    slot.event_id,
    slot.starts_at,
    slot.duration_minutes
  ].join('|')
}

function normalizeDateOptionSlots(payload) {
  const serverNow = payload?.server_now || nowIso()
  const slots = []
  const courts = Array.isArray(payload?.courts) ? payload.courts : []

  courts.forEach((court) => {
    const availableEvents = Array.isArray(court.available_events) ? court.available_events : []

    availableEvents.forEach((event) => {
      const availableSlots = Array.isArray(event.available_slots) ? event.available_slots : []

      availableSlots.forEach((slot) => {
        const bookingOpensAt = slot.booking_opens_at || ''
        slots.push({
          source: 'date-options',
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
        })
      })
    })
  })

  return slots
}

function normalizeAvailabilitySlots(payload, context) {
  const events = Array.isArray(payload?.events) ? payload.events : []
  const slots = []

  events.forEach((event) => {
    const starts = Array.isArray(event.starts) ? event.starts : []

    starts.forEach((start) => {
      Object.entries(start.durations || {}).forEach(([durationKey, durationValue]) => {
        const durationMinutes = Number(durationKey)
        const startsAt = start.starts_at || ''
        let endsAt = durationValue?.ends_at || ''

        if (!endsAt && startsAt && Number.isFinite(durationMinutes)) {
          const endDate = new Date(startsAt)
          endDate.setMinutes(endDate.getMinutes() + durationMinutes)
          endsAt = endDate.toISOString()
        }

        slots.push({
          source: 'availability',
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
        })
      })
    })
  })

  return slots
}

function mergeSlots(slots) {
  const map = new Map()

  slots.forEach((slot) => {
    const key = createSlotKey(slot)
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
      available_tickets: Math.max(Number(existing.available_tickets) || 0, Number(slot.available_tickets) || 0),
      raw_available_tickets: Math.max(Number(existing.raw_available_tickets) || 0, Number(slot.raw_available_tickets) || 0)
    })
  })

  return Array.from(map.values()).sort((left, right) => {
    const leftTime = new Date(left.starts_at).getTime()
    const rightTime = new Date(right.starts_at).getTime()
    if (leftTime !== rightTime) {
      return leftTime - rightTime
    }

    return createSlotKey(left).localeCompare(createSlotKey(right))
  })
}

function matchesSubscription(slot, subscription) {
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

  const modes = new Set(subscription.notify_modes.length ? subscription.notify_modes : DEFAULT_NOTIFY_MODES)

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

function renderSlotLine(slot) {
  const flags = []
  if (slot.booking_open === true) {
    flags.push('booking_open=true')
  } else if (slot.booking_open === false) {
    flags.push('booking_open=false')
  }

  if (slot.enabled === true) {
    flags.push('enabled=true')
  } else if (slot.enabled === false) {
    flags.push('enabled=false')
  }

  return [
    `- ${getEventTypeLabel(slot.event_type)}`,
    `${formatDateTimeHuman(slot.starts_at)} — ${slot.duration_minutes} мин`,
    `${slot.venue_title}, ${slot.court_title}`,
    `raw=${slot.raw_available_tickets}, visible=${slot.available_tickets}`,
    flags.join(', ') || 'статус неизвестен'
  ].join(' | ')
}

function renderAlertText(subscription, slots) {
  const header = [
    `Найдены слоты по подписке #${subscription.id}`,
    subscriptionSummary(subscription),
    ''
  ]

  const body = slots.map(renderSlotLine)
  return [...header, ...body].join('\n')
}

async function fetchDateOptionsForMonitor(venueId, eventType) {
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

async function fetchAvailabilityForMonitor(venueId, courtId, eventType, date) {
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

async function expireFinishedSubscriptions() {
  const subscriptions = listActiveSubscriptions()
  const current = getCurrentMskContext()

  for (const subscription of subscriptions) {
    if (!subscription.date_filter) {
      continue
    }

    if (subscription.date_filter < current.date || (subscription.date_filter === current.date && current.hour >= 22)) {
      deactivateSubscription(subscription.id)
      await sendTelegramMessage(
        subscription.chat_id,
        `Подписка #${subscription.id} на ${formatDateHuman(subscription.date_filter)} отключена: день закончился.`,
        buildMainMenuKeyboard()
      )
    }
  }
}

async function runMonitorTick() {
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
    const eventTypes = Array.from(new Set(subscriptions.flatMap((item) => item.event_types.map(String))))
    const dates = Array.from(new Set(subscriptions.map((item) => item.date_filter).filter(Boolean)))

    const dateOptionsResults = await Promise.all(
      venueIds.flatMap((venueId) => eventTypes.map((eventType) => fetchDateOptionsForMonitor(venueId, eventType)))
    )

    const serverNow =
      dateOptionsResults.find((item) => item.status < 400 && item.body?.server_now)?.body?.server_now || nowIso()
    const openWindowDates = new Set(buildSearchDates(3, serverNow))

    const dateOptionSlots = dateOptionsResults
      .filter((item) => item.status < 400)
      .flatMap((item) => normalizeDateOptionSlots(item.body))

    const availabilityQueries = Array.from(
      new Set(
        subscriptions.flatMap((subscription) =>
          subscription.venues.flatMap((venueId) =>
            subscription.event_types.flatMap((eventType) =>
              VENUES[String(venueId)].courts.map((courtId) =>
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

    const allSlots = mergeSlots([...dateOptionSlots, ...availabilitySlots]).filter((slot) => {
      if (!slot.event_date || slot.event_date > MAX_ALERT_DATE) {
        return false
      }

      return true
    })

    for (const subscription of subscriptions) {
      const matchingSlots = allSlots.filter((slot) => {
        if (!matchesSubscription(slot, subscription)) {
          return false
        }

        if (subscription.notify_modes.includes('ready')) {
          if (slot.event_date > addDaysYmd(getCurrentMskContext().date, 2) && slot.booking_open !== true) {
            const extraModes = new Set(subscription.notify_modes)
            if (!extraModes.has('api_visible') && !extraModes.has('disabled_visible')) {
              return false
            }
          }
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

      await sendTelegramMessage(subscription.chat_id, text, null)
      updateSubscriptionDelivery(subscription.id, fingerprint, text)
    }
  } catch (error) {
    console.error('Monitor tick failed:', error)
  } finally {
    monitorInProgress = false
  }
}

async function startMonitorLoop() {
  if (monitorLoopStarted) {
    return
  }

  monitorLoopStarted = true
  await runMonitorTick()
  setInterval(() => {
    runMonitorTick()
  }, MONITOR_INTERVAL_MS)
}

async function handleStartCommand(chatId) {
  clearState(chatId)
  await renderMenu(chatId)
}

async function handleMenuAction(chatId, messageId, action) {
  if (action === 'subscribe') {
    const state = createInitialWizardState(messageId)
    setState(chatId, state)
    await renderWizard(chatId, state, messageId)
    return
  }

  if (action === 'list') {
    clearState(chatId)
    await renderSubscriptionsList(chatId, messageId, 'list')
    return
  }

  if (action === 'unsubscribe') {
    clearState(chatId)
    await renderSubscriptionsList(chatId, messageId, 'unsubscribe')
    return
  }

  await renderMenu(chatId, messageId)
}

async function handleSubscriptionCallback(chatId, messageId, parts) {
  const state = getState(chatId) || createInitialWizardState(messageId)
  state.message_id = messageId

  const category = parts[1]
  const action = parts[2]
  const value = parts[3]

  if (category === 'cancel') {
    clearState(chatId)
    await renderMenu(chatId, messageId)
    return
  }

  if (category === 'back') {
    const previousState = popHistory(state)
    await renderWizard(chatId, previousState, messageId)
    return
  }

  if (category === 'venues') {
    if (action === 'add' && value) {
      state.data.venues = Array.from(new Set([...state.data.venues.map(String), String(value)]))
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'all') {
      state.data.venues = Object.keys(VENUES)
      state.history = [...state.history, state.step]
      state.step = 'event_types'
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'done' && state.data.venues.length) {
      state.history = [...state.history, state.step]
      state.step = 'event_types'
      await renderWizard(chatId, state, messageId)
      return
    }
  }

  if (category === 'event_types') {
    if (action === 'add' && value) {
      state.data.event_types = Array.from(new Set([...state.data.event_types.map(String), String(value)]))
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'all') {
      state.data.event_types = [...SUPPORTED_MONITOR_EVENT_TYPES]
      state.history = [...state.history, state.step]
      state.step = 'durations'
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'done' && state.data.event_types.length) {
      state.history = [...state.history, state.step]
      state.step = 'durations'
      await renderWizard(chatId, state, messageId)
      return
    }
  }

  if (category === 'durations') {
    if (action === 'add' && value) {
      state.data.durations = Array.from(new Set([...state.data.durations.map(Number), Number(value)])).sort((a, b) => a - b)
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'all') {
      state.data.durations = [...DURATION_OPTIONS]
      state.history = [...state.history, state.step]
      state.step = 'tickets'
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'done' && state.data.durations.length) {
      state.history = [...state.history, state.step]
      state.step = 'tickets'
      await renderWizard(chatId, state, messageId)
      return
    }
  }

  if (category === 'tickets' && action === 'set' && value) {
    state.data.min_raw_tickets = Number(value) || 1
    state.history = [...state.history, state.step]
    state.step = 'date_input'
    await renderWizard(chatId, state, messageId)
    return
  }

  if (category === 'notify') {
    if (action === 'add' && value) {
      state.data.notify_modes = Array.from(new Set(['ready', ...state.data.notify_modes, value]))
      await renderWizard(chatId, state, messageId)
      return
    }

    if (action === 'default') {
      state.data.notify_modes = [...DEFAULT_NOTIFY_MODES]
      const subscriptionId = createSubscription({
        chat_id: chatId,
        ...state.data
      })
      clearState(chatId)
      await editTelegramMessage(
        chatId,
        messageId,
        `Подписка #${subscriptionId} сохранена.\n\n${subscriptionSummary(state.data)}`,
        {
          inline_keyboard: [[button('В меню', 'menu|home')]]
        }
      )
      return
    }

    if (action === 'done') {
      if (!state.data.notify_modes.length) {
        state.data.notify_modes = [...DEFAULT_NOTIFY_MODES]
      }
      const subscriptionId = createSubscription({
        chat_id: chatId,
        ...state.data
      })
      clearState(chatId)
      await editTelegramMessage(
        chatId,
        messageId,
        `Подписка #${subscriptionId} сохранена.\n\n${subscriptionSummary(state.data)}`,
        {
          inline_keyboard: [[button('В меню', 'menu|home')]]
        }
      )
      return
    }
  }
}

async function handleTextMessage(message) {
  if (!message?.chat?.id) {
    return
  }

  const chatId = String(message.chat.id)
  saveUser(message.from)

  const text = String(message.text || '').trim()
  if (text === '/start') {
    await handleStartCommand(chatId)
    return
  }

  if (text === '/subscriptions') {
    await renderSubscriptionsList(chatId, null, 'list')
    return
  }

  const state = getState(chatId)
  if (!state || state.flow !== 'subscription') {
    return
  }

  if (state.step !== 'date_input') {
    return
  }

  const parsedDate = parseFlexibleDateInput(text)
  if (!parsedDate.ok) {
    await sendTelegramMessage(chatId, parsedDate.error, {
      inline_keyboard: [[button('Назад', 'sub|back'), button('Отмена', 'sub|cancel')]]
    })
    return
  }

  state.data.date_filter = parsedDate.date
  state.history = [...state.history, state.step]
  state.step = 'notify_modes'
  await renderWizard(chatId, state, state.message_id)
}

async function handleCallbackQuery(callbackQuery) {
  const chatId = String(callbackQuery?.from?.id || callbackQuery?.message?.chat?.id || '')
  const messageId = Number(callbackQuery?.message?.message_id || 0)
  const data = String(callbackQuery?.data || '')

  if (!chatId || !data) {
    return
  }

  saveUser(callbackQuery.from)

  const parts = data.split('|')

  if (parts[0] === 'menu') {
    await handleMenuAction(chatId, messageId, parts[1])
    await answerCallbackQuery(callbackQuery.id)
    return
  }

  if (parts[0] === 'sub') {
    await handleSubscriptionCallback(chatId, messageId, parts)
    await answerCallbackQuery(callbackQuery.id)
    return
  }

  if (parts[0] === 'unsub' && parts[1]) {
    deactivateSubscriptionForChat(parts[1], chatId)
    await renderSubscriptionsList(chatId, messageId, 'unsubscribe')
    await answerCallbackQuery(callbackQuery.id, 'Подписка отключена')
    return
  }

  await answerCallbackQuery(callbackQuery.id)
}

async function pollTelegramUpdates() {
  if (!TELEGRAM_API_BASE) {
    console.log('Telegram bot token is not set. Bot features are disabled.')
    return
  }

  if (telegramLoopStarted) {
    return
  }

  telegramLoopStarted = true

  while (true) {
    try {
      const offset = Number(getKv('telegram_update_offset') || '0')
      const response = await telegramApi('getUpdates', {
        offset,
        timeout: TELEGRAM_POLL_TIMEOUT_SECONDS,
        allowed_updates: ['message', 'callback_query']
      })

      if (!response.ok) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        continue
      }

      const updates = Array.isArray(response.result) ? response.result : []
      for (const update of updates) {
        setKv('telegram_update_offset', String(Number(update.update_id) + 1))

        if (update.message?.text) {
          await handleTextMessage(update.message)
        }

        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query)
        }
      }
    } catch (error) {
      console.error('Telegram polling failed:', error)
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

async function start() {
  const app = express()

  app.use((req, res, next) => {
    setCorsHeaders(res)

    if (req.method === 'OPTIONS') {
      res.status(204).end()
      return
    }

    next()
  })

  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'mos-sport-backend',
      port: PORT,
      telegram_enabled: Boolean(TELEGRAM_BOT_TOKEN),
      sqlite_path: SQLITE_PATH
    })
  })

  app.get('/api/venues', async (req, res) => {
    const result = await callOutdoorApi(`/items/venues?${VENUES_QUERY}`, 'GET')
    sendUpstreamResult(res, result)
  })

  app.get('/api/date-options', async (req, res) => {
    const query = buildQueryString({
      event_type: req.query.event_type,
      venue_id: req.query.venue_id
    })
    const result = await callOutdoorApi(`/booking/date-options${query}`, 'GET')
    sendUpstreamResult(res, result)
  })

  app.get('/api/availability', async (req, res) => {
    const query = buildQueryString({
      event_type: req.query.event_type,
      venue_id: req.query.venue_id,
      court_id: req.query.court_id,
      date: req.query.date
    })
    const result = await callOutdoorApi(`/booking/availability${query}`, 'GET')
    sendUpstreamResult(res, result)
  })

  app.post('/api/session', async (req, res) => {
    const result = await callOutdoorApi('/booking/session', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  app.put('/api/hold', async (req, res) => {
    const { session_id: sessionId, ...payload } = req.body
    const result = await callOutdoorApi(`/booking/session/${encodeURIComponent(sessionId)}/hold`, 'PUT', payload)
    sendUpstreamResult(res, result)
  })

  app.post('/api/sms-send', async (req, res) => {
    const result = await callOutdoorApi('/booking/sms/send', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  app.post('/api/sms-verify', async (req, res) => {
    const result = await callOutdoorApi('/booking/sms/verify', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  app.post('/api/confirm', async (req, res) => {
    const result = await callOutdoorApi('/booking/confirm', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  app.get('/api/subscriptions/debug', (req, res) => {
    res.json({
      subscriptions: listActiveSubscriptions()
    })
  })

  app.listen(PORT, () => {
    console.log(`Backend started on http://0.0.0.0:${PORT}`)
  })

  pollTelegramUpdates()
  startMonitorLoop()
}

start()
