import express from 'express'
import { PORT, TELEGRAM_BOT_TOKEN } from './config'
import { createApiRouter, setCorsHeaders } from './routes/api'
import { startTelegramPolling } from './services/bot'
import { startMonitorLoop } from './services/monitor'

async function start(): Promise<void> {
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
  app.use(createApiRouter())

  app.listen(PORT, () => {
    console.log(`Backend started on http://0.0.0.0:${PORT}`)
  })

  if (TELEGRAM_BOT_TOKEN) {
    void startTelegramPolling()
  } else {
    console.log('Telegram bot token is not set. Bot features are disabled.')
  }

  void startMonitorLoop()
}

void start()
