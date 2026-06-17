export interface OutdoorApiResult {
  status: number
  body: unknown
  isJson: boolean
}

export interface MonitorSlot {
  source: 'date-options' | 'availability'
  venue_id: string
  venue_title: string
  court_id: string
  court_title: string
  event_type: string
  event_title: string
  event_id: number
  event_date: string
  starts_at: string
  ends_at: string
  duration_minutes: number
  booking_opens_at: string
  booking_open: boolean | null
  enabled: boolean | null
  available_tickets: number
  raw_available_tickets: number
}

export interface Subscription {
  id: number
  chat_id: string
  venues: string[]
  event_types: string[]
  durations: number[]
  min_raw_tickets: number
  date_filter: string
  notify_modes: string[]
  active: boolean
  last_sent_fingerprint: string
  last_sent_text: string
  created_at: string
  updated_at: string
  ended_at: string
  end_reason: string
}

export interface SubscriptionDbRow {
  id: number
  chat_id: string
  venues_json: string
  event_types_json: string
  durations_json: string
  min_raw_tickets: number
  date_filter: string
  notify_modes_json: string
  active: number
  last_sent_fingerprint: string | null
  last_sent_text: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  end_reason: string | null
}

export interface WizardData {
  venues: string[]
  event_types: string[]
  durations: number[]
  min_raw_tickets: number
  date_filter: string
  notify_modes: string[]
}

export interface WizardState {
  flow: 'subscription'
  step: 'venues' | 'event_types' | 'durations' | 'tickets' | 'date_input' | 'notify_modes'
  history: Array<WizardState['step']>
  message_id: number | null
  data: WizardData
}

export interface TelegramUser {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramMessage {
  message_id: number
  chat: { id: number }
  text?: string
  from?: TelegramUser
}

export interface TelegramCallbackQuery {
  id: string
  from?: TelegramUser
  data?: string
  message?: TelegramMessage
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
}
