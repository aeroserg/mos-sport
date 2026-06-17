import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SQLITE_PATH } from './config'
import { Subscription, SubscriptionDbRow, TelegramUser, WizardState } from './types'
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
`)

ensureColumn('subscriptions', 'ended_at', 'TEXT')
ensureColumn('subscriptions', 'end_reason', 'TEXT')

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
      updated_at,
      ended_at,
      end_reason
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
  `)
}

function normalizeSubscriptionRow(row: SubscriptionDbRow): Subscription {
  return {
    id: row.id,
    chat_id: row.chat_id,
    venues: (jsonParseArray(row.venues_json, []) as string[]).map(String),
    event_types: (jsonParseArray(row.event_types_json, []) as string[]).map(String),
    durations: (jsonParseArray(row.durations_json, []) as number[]).map(Number),
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
