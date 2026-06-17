import { Router } from 'express'
import { CORS_ORIGIN, PORT, VENUES_QUERY } from '../config'
import { listActiveSubscriptions } from '../db'
import { callOutdoorApi } from '../services/outdoor'
import { buildQueryString } from '../utils/domain'

export function setCorsHeaders(res: {
  setHeader: (name: string, value: string) => void
}): void {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

function sendUpstreamResult(
  res: {
    status: (code: number) => { json: (body: unknown) => void; send: (body: unknown) => void }
  },
  result: { status: number; body: unknown; isJson: boolean }
): void {
  if (result.isJson) {
    res.status(result.status).json(result.body)
    return
  }

  res.status(result.status).send(result.body)
}

export function createApiRouter(): Router {
  const router = Router()

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      service: 'mos-sport-backend',
      port: PORT
    })
  })

  router.get('/api/venues', async (req, res) => {
    const result = await callOutdoorApi(`/items/venues?${VENUES_QUERY}`, 'GET')
    sendUpstreamResult(res, result)
  })

  router.get('/api/date-options', async (req, res) => {
    const query = buildQueryString({
      event_type: req.query.event_type,
      venue_id: req.query.venue_id
    })
    const result = await callOutdoorApi(`/booking/date-options${query}`, 'GET')
    sendUpstreamResult(res, result)
  })

  router.get('/api/availability', async (req, res) => {
    const query = buildQueryString({
      event_type: req.query.event_type,
      venue_id: req.query.venue_id,
      court_id: req.query.court_id,
      date: req.query.date
    })
    const result = await callOutdoorApi(`/booking/availability${query}`, 'GET')
    sendUpstreamResult(res, result)
  })

  router.post('/api/session', async (req, res) => {
    const result = await callOutdoorApi('/booking/session', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  router.put('/api/hold', async (req, res) => {
    const { session_id: sessionId, ...payload } = req.body as Record<string, unknown>
    const result = await callOutdoorApi(`/booking/session/${encodeURIComponent(String(sessionId))}/hold`, 'PUT', payload)
    sendUpstreamResult(res, result)
  })

  router.post('/api/sms-send', async (req, res) => {
    const result = await callOutdoorApi('/booking/sms/send', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  router.post('/api/sms-verify', async (req, res) => {
    const result = await callOutdoorApi('/booking/sms/verify', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  router.post('/api/confirm', async (req, res) => {
    const result = await callOutdoorApi('/booking/confirm', 'POST', req.body)
    sendUpstreamResult(res, result)
  })

  router.get('/api/subscriptions/debug', (req, res) => {
    res.json({
      subscriptions: listActiveSubscriptions()
    })
  })

  return router
}
