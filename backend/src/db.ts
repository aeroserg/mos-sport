import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { CONSENT_DOCUMENT_URL } from './config'
import { SQLITE_PATH } from './config'
import {
  ConsentDbRow,
  ConsentRecord,
  InstantBookingRequest,
  InstantBookingRequestDbRow,
  Subscription,
  SubscriptionDbRow,
  TelegramUser,
  WizardState
} from './types'
import { nowIso } from './utils/date'
import { jsonParseArray } from './utils/domain'

fs.mkdirSync(path.dirname(SQLITE_PATH), { recursive: true })
const db = new Database(SQLITE_PATH)
db.pragma('journal_mode = WAL')

function tableHasColumn(tableName: string, columnName: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  return columns.some((column) => column.name === columnName)
}

function ensureColumn(tableName: string, columnName: string, definition: string): void {
  if (!tableHasColumn(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

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
    start_times_json TEXT NOT NULL DEFAULT '[]',
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

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consents (
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    document_url TEXT NOT NULL,
    source TEXT NOT NULL,
    accepted INTEGER NOT NULL DEFAULT 1,
    accepted_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subject_type, subject_id)
  );

  CREATE TABLE IF NOT EXISTS instant_booking_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    court_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    tickets_count INTEGER NOT NULL,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL,
    subscribe_on_match INTEGER NOT NULL DEFAULT 0,
    notify_gray INTEGER NOT NULL DEFAULT 0,
    alert_subscription_id INTEGER,
    status TEXT NOT NULL,
    session_id TEXT,
    hold_id TEXT,
    event_id INTEGER,
    starts_at TEXT,
    ends_at TEXT,
    expires_at TEXT,
    last_error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
`)

ensureColumn('subscriptions', 'ended_at', 'TEXT')
ensureColumn('subscriptions', 'end_reason', 'TEXT')
ensureColumn('subscriptions', 'start_times_json', `TEXT NOT NULL DEFAULT '[]'`)

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
      start_times_json,
      min_raw_tickets,
      date_filter,
      notify_modes_json,
      active,
      last_sent_fingerprint,
      last_sent_text,
      created_at,
      updated_at,
      ended_at,
      end_reason
    ) VALUES (
      @chat_id,
      @venues_json,
      @event_types_json,
      @durations_json,
      @start_times_json,
      @min_raw_tickets,
      @date_filter,
      @notify_modes_json,
      1,
      NULL,
      NULL,
      @created_at,
      @updated_at,
      '',
      ''
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
    SET active = 0, updated_at = ?, ended_at = ?, end_reason = ?
    WHERE id = ?
  `),
  deactivateSubscriptionForChat: db.prepare(`
    UPDATE subscriptions
    SET active = 0, updated_at = ?, ended_at = ?, end_reason = ?
    WHERE id = ? AND chat_id = ?
  `),
  updateSubscriptionDelivery: db.prepare(`
    UPDATE subscriptions
    SET last_sent_fingerprint = ?, last_sent_text = ?, updated_at = ?
    WHERE id = ?
  `),
  addNotification: db.prepare(`
    INSERT INTO notifications (subscription_id, fingerprint, text, sent_at)
    VALUES (?, ?, ?, ?)
  `),
  getKv: db.prepare('SELECT value FROM kv WHERE key = ?'),
  setKv: db.prepare(`
    INSERT INTO kv (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `),
  getConsent: db.prepare(`
    SELECT *
    FROM consents
    WHERE subject_type = ? AND subject_id = ?
  `),
  upsertConsent: db.prepare(`
    INSERT INTO consents (
      subject_type,
      subject_id,
      document_url,
      source,
      accepted,
      accepted_at,
      created_at,
      updated_at
    )
    VALUES (@subject_type, @subject_id, @document_url, @source, 1, @accepted_at, @created_at, @updated_at)
    ON CONFLICT(subject_type, subject_id) DO UPDATE SET
      document_url = excluded.document_url,
      source = excluded.source,
      accepted = 1,
      accepted_at = excluded.accepted_at,
      updated_at = excluded.updated_at
  `),
  createInstantBookingRequest: db.prepare(`
    INSERT INTO instant_booking_requests (
      chat_id,
      venue_id,
      court_id,
      event_type,
      event_date,
      start_time,
      duration_minutes,
      tickets_count,
      first_name,
      last_name,
      phone,
      email,
      subscribe_on_match,
      notify_gray,
      alert_subscription_id,
      status,
      session_id,
      hold_id,
      event_id,
      starts_at,
      ends_at,
      expires_at,
      last_error_json,
      created_at,
      updated_at,
      finished_at
    ) VALUES (
      @chat_id,
      @venue_id,
      @court_id,
      @event_type,
      @event_date,
      @start_time,
      @duration_minutes,
      @tickets_count,
      @first_name,
      @last_name,
      @phone,
      @email,
      @subscribe_on_match,
      @notify_gray,
      @alert_subscription_id,
      'queued',
      '',
      '',
      NULL,
      '',
      '',
      '',
      '',
      @created_at,
      @updated_at,
      ''
    )
  `),
  listInstantBookingRequestsByChat: db.prepare(`
    SELECT *
    FROM instant_booking_requests
    WHERE chat_id = ?
    ORDER BY created_at DESC, id DESC
  `),
  listActiveInstantBookingRequests: db.prepare(`
    SELECT *
    FROM instant_booking_requests
    WHERE status IN ('queued', 'awaiting_code')
    ORDER BY created_at ASC, id ASC
  `),
  getActiveInstantBookingRequestByChat: db.prepare(`
    SELECT *
    FROM instant_booking_requests
    WHERE chat_id = ? AND status IN ('queued', 'awaiting_code')
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `),
  getAwaitingCodeRequestByChat: db.prepare(`
    SELECT *
    FROM instant_booking_requests
    WHERE chat_id = ? AND status = 'awaiting_code'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `),
  countQueueForSlot: db.prepare(`
    SELECT COUNT(*) as count
    FROM instant_booking_requests
    WHERE venue_id = ?
      AND event_type = ?
      AND event_date = ?
      AND start_time = ?
      AND duration_minutes = ?
      AND status IN ('queued', 'awaiting_code')
  `),
  updateInstantBookingAwaitingCode: db.prepare(`
    UPDATE instant_booking_requests
    SET status = 'awaiting_code',
      session_id = @session_id,
      hold_id = @hold_id,
      event_id = @event_id,
      starts_at = @starts_at,
      ends_at = @ends_at,
      expires_at = @expires_at,
      last_error_json = '',
      updated_at = @updated_at
    WHERE id = @id
  `),
  finishInstantBookingRequest: db.prepare(`
    UPDATE instant_booking_requests
    SET status = @status,
      last_error_json = @last_error_json,
      updated_at = @updated_at,
      finished_at = @finished_at
    WHERE id = @id
  `)
}

function normalizeSubscriptionRow(row: SubscriptionDbRow): Subscription {
  return {
    id: row.id,
    chat_id: row.chat_id,
    venues: (jsonParseArray(row.venues_json, []) as string[]).map(String),
    event_types: (jsonParseArray(row.event_types_json, []) as string[]).map(String),
    durations: (jsonParseArray(row.durations_json, []) as number[]).map(Number),
    start_times: (jsonParseArray(row.start_times_json || '[]', []) as string[]).map(String),
    min_raw_tickets: Number(row.min_raw_tickets) || 1,
    date_filter: row.date_filter,
    notify_modes: (jsonParseArray(row.notify_modes_json, []) as string[]).map(String),
    active: Boolean(row.active),
    last_sent_fingerprint: row.last_sent_fingerprint || '',
    last_sent_text: row.last_sent_text || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    ended_at: row.ended_at || '',
    end_reason: row.end_reason || ''
  }
}

function normalizeInstantBookingRequestRow(row: InstantBookingRequestDbRow): InstantBookingRequest {
  return {
    id: row.id,
    chat_id: row.chat_id,
    venue_id: row.venue_id,
    court_id: row.court_id,
    event_type: row.event_type,
    event_date: row.event_date,
    start_time: row.start_time,
    duration_minutes: Number(row.duration_minutes) || 0,
    tickets_count: Number(row.tickets_count) || 1,
    first_name: row.first_name,
    last_name: row.last_name,
    phone: row.phone,
    email: row.email,
    subscribe_on_match: Boolean(row.subscribe_on_match),
    notify_gray: Boolean(row.notify_gray),
    alert_subscription_id: row.alert_subscription_id ?? null,
    status: row.status,
    session_id: row.session_id || '',
    hold_id: row.hold_id || '',
    event_id: row.event_id ?? null,
    starts_at: row.starts_at || '',
    ends_at: row.ends_at || '',
    expires_at: row.expires_at || '',
    last_error_json: row.last_error_json || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at || ''
  }
}

function normalizeConsentRow(row: ConsentDbRow): ConsentRecord {
  return {
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    document_url: row.document_url,
    source: row.source,
    accepted: Boolean(row.accepted),
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

export function saveUser(user?: TelegramUser): void {
  if (!user?.id) {
    return
  }

  const timestamp = nowIso()
  statements.upsertUser.run({
    chat_id: String(user.id),
    username: user.username || '',
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    created_at: timestamp,
    updated_at: timestamp
  })
}

export function getState(chatId: string): WizardState | null {
  const row = statements.getState.get(chatId) as { state_json: string } | undefined
  if (!row) {
    return null
  }

  try {
    return JSON.parse(row.state_json) as WizardState
  } catch {
    return null
  }
}

export function setState(chatId: string, state: WizardState): void {
  statements.setState.run(chatId, JSON.stringify(state), nowIso())
}

export function clearState(chatId: string): void {
  statements.clearState.run(chatId)
}

export function createSubscription(subscription: Omit<Subscription, 'id' | 'active' | 'last_sent_fingerprint' | 'last_sent_text' | 'created_at' | 'updated_at' | 'ended_at' | 'end_reason'>): number {
  const timestamp = nowIso()
  const result = statements.createSubscription.run({
    chat_id: String(subscription.chat_id),
    venues_json: JSON.stringify(subscription.venues),
    event_types_json: JSON.stringify(subscription.event_types),
    durations_json: JSON.stringify(subscription.durations),
    start_times_json: JSON.stringify(subscription.start_times || []),
    min_raw_tickets: Number(subscription.min_raw_tickets) || 1,
    date_filter: subscription.date_filter,
    notify_modes_json: JSON.stringify(subscription.notify_modes),
    created_at: timestamp,
    updated_at: timestamp
  }) as { lastInsertRowid: number | bigint }

  return Number(result.lastInsertRowid)
}

export function listSubscriptionsByChat(chatId: string): Subscription[] {
  return (statements.listSubscriptionsByChat.all(chatId) as SubscriptionDbRow[]).map(normalizeSubscriptionRow)
}

export function listActiveSubscriptions(): Subscription[] {
  return (statements.listActiveSubscriptions.all() as SubscriptionDbRow[]).map(normalizeSubscriptionRow)
}

export function deactivateSubscription(id: number, reason: string): void {
  const timestamp = nowIso()
  statements.deactivateSubscription.run(timestamp, timestamp, reason, id)
}

export function deactivateSubscriptionForChat(id: number, chatId: string, reason: string): void {
  const timestamp = nowIso()
  statements.deactivateSubscriptionForChat.run(timestamp, timestamp, reason, id, chatId)
}

export function updateSubscriptionDelivery(id: number, fingerprint: string, text: string): void {
  const timestamp = nowIso()
  statements.updateSubscriptionDelivery.run(fingerprint, text, timestamp, id)
  statements.addNotification.run(id, fingerprint, text, timestamp)
}

export function getKv(key: string): string {
  const row = statements.getKv.get(key) as { value: string } | undefined
  return row?.value || ''
}

export function setKv(key: string, value: string): void {
  statements.setKv.run(key, value, nowIso())
}

export function getConsent(subjectType: ConsentRecord['subject_type'], subjectId: string): ConsentRecord | null {
  const row = statements.getConsent.get(subjectType, subjectId) as ConsentDbRow | undefined
  return row ? normalizeConsentRow(row) : null
}

export function setConsentAccepted(input: {
  subjectType: ConsentRecord['subject_type']
  subjectId: string
  source: string
  documentUrl?: string
}): ConsentRecord {
  const timestamp = nowIso()
  statements.upsertConsent.run({
    subject_type: input.subjectType,
    subject_id: input.subjectId,
    document_url: input.documentUrl || CONSENT_DOCUMENT_URL,
    source: input.source,
    accepted_at: timestamp,
    created_at: timestamp,
    updated_at: timestamp
  })

  return getConsent(input.subjectType, input.subjectId) as ConsentRecord
}

export function createInstantBookingRequest(
  request: Omit<
    InstantBookingRequest,
    | 'id'
    | 'status'
    | 'session_id'
    | 'hold_id'
    | 'event_id'
    | 'starts_at'
    | 'ends_at'
    | 'expires_at'
    | 'last_error_json'
    | 'created_at'
    | 'updated_at'
    | 'finished_at'
  >
): number {
  const timestamp = nowIso()
  const result = statements.createInstantBookingRequest.run({
    ...request,
    subscribe_on_match: request.subscribe_on_match ? 1 : 0,
    notify_gray: request.notify_gray ? 1 : 0,
    alert_subscription_id: request.alert_subscription_id,
    created_at: timestamp,
    updated_at: timestamp
  }) as { lastInsertRowid: number | bigint }

  return Number(result.lastInsertRowid)
}

export function listInstantBookingRequestsByChat(chatId: string): InstantBookingRequest[] {
  return (statements.listInstantBookingRequestsByChat.all(chatId) as InstantBookingRequestDbRow[]).map(
    normalizeInstantBookingRequestRow
  )
}

export function listActiveInstantBookingRequests(): InstantBookingRequest[] {
  return (statements.listActiveInstantBookingRequests.all() as InstantBookingRequestDbRow[]).map(
    normalizeInstantBookingRequestRow
  )
}

export function getActiveInstantBookingRequestByChat(chatId: string): InstantBookingRequest | null {
  const row = statements.getActiveInstantBookingRequestByChat.get(chatId) as InstantBookingRequestDbRow | undefined
  return row ? normalizeInstantBookingRequestRow(row) : null
}

export function getAwaitingCodeRequestByChat(chatId: string): InstantBookingRequest | null {
  const row = statements.getAwaitingCodeRequestByChat.get(chatId) as InstantBookingRequestDbRow | undefined
  return row ? normalizeInstantBookingRequestRow(row) : null
}

export function countQueueForSlot(input: {
  venue_id: string
  court_id: string
  event_type: string
  event_date: string
  start_time: string
  duration_minutes: number
}): number {
  const row = statements.countQueueForSlot.get(
    input.venue_id,
    input.event_type,
    input.event_date,
    input.start_time,
    input.duration_minutes
  ) as { count: number } | undefined

  return Number(row?.count) || 0
}

export function updateInstantBookingAwaitingCode(input: {
  id: number
  session_id: string
  hold_id: string
  event_id: number
  starts_at: string
  ends_at: string
  expires_at: string
}): void {
  statements.updateInstantBookingAwaitingCode.run({
    ...input,
    updated_at: nowIso()
  })
}

export function finishInstantBookingRequest(
  id: number,
  status: InstantBookingRequest['status'],
  lastErrorJson = ''
): void {
  const timestamp = nowIso()
  statements.finishInstantBookingRequest.run({
    id,
    status,
    last_error_json: lastErrorJson,
    updated_at: timestamp,
    finished_at: timestamp
  })
}
