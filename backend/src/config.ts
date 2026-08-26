import path from 'node:path'

export const PORT = Number(process.env.PORT) || 4003
export const API_BASE_URL = process.env.OUTDOOR_API_BASE_URL || 'https://api.outdoor.sport.mos.ru'
export const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
export const SQLITE_PATH = process.env.SQLITE_PATH || path.resolve(process.cwd(), 'data/mos-sport.sqlite')
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
export const TELEGRAM_API_BASE = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : ''
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 25
export const MONITOR_INTERVAL_MS = Number(process.env.MONITOR_INTERVAL_MS) || 10000
export const TIMEZONE = 'Europe/Moscow'
export const MAX_ALERT_DATE = '2026-09-30'
export const SUPPORTED_MONITOR_EVENT_TYPES = ['free_play', 'masterclass'] as const
export const DURATION_OPTIONS = [30, 60, 90, 120, 180] as const
export const DEFAULT_NOTIFY_MODES = ['ready'] as const
export const CONSENT_DOCUMENT_FILENAME = '81758d52-3d00-45ae-a7ca-ba526f3d45c1.docx'
export const CONSENT_DOCUMENT_URL =
  process.env.CONSENT_DOCUMENT_URL || `https://aeroserg.github.io/mos-sport/${CONSENT_DOCUMENT_FILENAME}`

export const EVENT_TYPE_LABELS: Record<string, string> = {
  free_play: 'Свободная игра',
  masterclass: 'Мастер-класс',
  tournament_60: 'Турнир 60 минут',
  tournament_120: 'Турнир 120 минут',
  tournament_180: 'Турнир 180 минут'
}

export const VENUES = {
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
} as const

export const COMMON_HEADERS = {
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

export const VENUES_QUERY =
  'filter[status][_eq]=published&sort=sort&fields=id,title,image,address,working_hours,sort,status,tags.id,tags.venues_id,tags.tags_id.id,tags.tags_id.name'

export const MONTHS: Record<string, number> = {
  январь: 1,
  января: 1,
  январе: 1,
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
