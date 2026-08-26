import { TELEGRAM_API_BASE } from '../config'
import { InlineKeyboardMarkup, TelegramUpdate } from '../types'

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function telegramApi<T>(method: string, payload: unknown): Promise<TelegramApiResponse<T>> {
  if (!TELEGRAM_API_BASE) {
    return { ok: false, description: 'telegram_disabled' }
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload || {})
    })
    return (await response.json()) as TelegramApiResponse<T>
  } catch (error) {
    console.error(`Telegram API error for ${method}:`, error)
    return {
      ok: false,
      description: error instanceof Error ? error.message : 'unknown_telegram_error'
    }
  }
}

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  replyMarkup: InlineKeyboardMarkup | null,
  options?: { parseMode?: 'HTML' | 'MarkdownV2' | null }
): Promise<number | null> {
  const result = await telegramApi<{ message_id: number }>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode === undefined ? 'HTML' : options.parseMode || undefined,
    reply_markup: replyMarkup || undefined,
    disable_web_page_preview: true
  })

  return result.ok && result.result ? result.result.message_id : null
}

export async function editTelegramMessage(
  chatId: string,
  messageId: number,
  text: string,
  replyMarkup: InlineKeyboardMarkup | null
): Promise<void> {
  const result = await telegramApi('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup || undefined,
    disable_web_page_preview: true
  })

  if (!result.ok && !String(result.description || '').includes('message is not modified')) {
    console.error('Failed to edit Telegram message:', result)
  }
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await telegramApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false
  })
}

export async function getTelegramUpdates(
  offset: number,
  timeout: number
): Promise<TelegramApiResponse<TelegramUpdate[]>> {
  return telegramApi<TelegramUpdate[]>('getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message', 'callback_query']
  })
}
