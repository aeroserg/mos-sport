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
  start_times: string[]
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
  start_times_json: string | null
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

export interface ConsentRecord {
  subject_type: 'telegram' | 'web'
  subject_id: string
  document_url: string
  source: string
  accepted: boolean
  accepted_at: string
  created_at: string
  updated_at: string
}

export interface ConsentDbRow {
  subject_type: 'telegram' | 'web'
  subject_id: string
  document_url: string
  source: string
  accepted: number
  accepted_at: string
  created_at: string
  updated_at: string
}

export interface WizardData {
  venues: string[]
  event_types: string[]
  durations: number[]
  start_times: string[]
  min_raw_tickets: number
  date_filters: string[]
  notify_modes: string[]
  instant_venue?: string
  instant_event_type?: string
  instant_duration?: number
  instant_tickets?: number
  instant_date?: string
  instant_time?: string
  instant_notify_on_match?: boolean
  instant_notify_gray?: boolean
  instant_first_name?: string
  instant_last_name?: string
  instant_phone?: string
  instant_email?: string
  instant_confirmed?: boolean
}

export interface WizardState {
  flow: 'subscription' | 'instant_booking'
  step:
    | 'venues'
    | 'event_types'
    | 'durations'
    | 'tickets'
    | 'date_input'
    | 'notify_modes'
    | 'instant_intro'
    | 'instant_venue'
    | 'instant_event_type'
    | 'instant_duration'
    | 'instant_tickets'
    | 'instant_date'
    | 'instant_time'
    | 'instant_alerts'
    | 'instant_alerts_gray'
    | 'instant_first_name'
    | 'instant_last_name'
    | 'instant_phone'
    | 'instant_email'
    | 'instant_queue_confirm'
  history: Array<WizardState['step']>
  message_id: number | null
  data: WizardData
}

export type InstantBookingStatus =
  | 'queued'
  | 'awaiting_code'
  | 'confirmed'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface InstantBookingRequest {
  id: number
  chat_id: string
  venue_id: string
  court_id: string
  event_type: string
  event_date: string
  start_time: string
  duration_minutes: number
  tickets_count: number
  first_name: string
  last_name: string
  phone: string
  email: string
  subscribe_on_match: boolean
  notify_gray: boolean
  alert_subscription_id: number | null
  status: InstantBookingStatus
  session_id: string
  hold_id: string
  event_id: number | null
  starts_at: string
  ends_at: string
  expires_at: string
  last_error_json: string
  created_at: string
  updated_at: string
  finished_at: string
}

export interface InstantBookingRequestDbRow {
  id: number
  chat_id: string
  venue_id: string
  court_id: string
  event_type: string
  event_date: string
  start_time: string
  duration_minutes: number
  tickets_count: number
  first_name: string
  last_name: string
  phone: string
  email: string
  subscribe_on_match: number
  notify_gray: number
  alert_subscription_id: number | null
  status: InstantBookingStatus
  session_id: string | null
  hold_id: string | null
  event_id: number | null
  starts_at: string | null
  ends_at: string | null
  expires_at: string | null
  last_error_json: string | null
  created_at: string
  updated_at: string
  finished_at: string | null
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

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: Array<Array<InlineKeyboardButton>>
}
