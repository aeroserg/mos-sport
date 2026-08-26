import { Router } from 'express'
import { CORS_ORIGIN, CONSENT_DOCUMENT_URL, PORT, VENUES_QUERY } from '../config'
import { getConsent, listActiveSubscriptions, setConsentAccepted } from '../db'
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

  const getConsentHandler = (req: { query: Record<string, unknown> }, res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void }) => {
    const clientId = String(req.query.client_id || '').trim()

    if (!clientId) {
      res.status(400).json({
        status: 400,
        error: 'client_id_required',
        message: 'client_id is required'
      })
      return
    }

    const consent = getConsent('web', clientId)

    if (!consent?.accepted) {
      res.status(404).json({
        status: 404,
        accepted: false,
        document_url: CONSENT_DOCUMENT_URL
      })
      return
    }

    res.json({
      status: 200,
      accepted: true,
      client_id: clientId,
      document_url: consent.document_url,
      accepted_at: consent.accepted_at,
      source: consent.source
    })
  }

  const saveConsentHandler = (req: { body?: Record<string, unknown> }, res: { status: (code: number) => { json: (body: unknown) => void }; json: (body: unknown) => void }) => {
    const clientId = String(req.body?.client_id || '').trim()
    const accepted = req.body?.accepted === true

    if (!clientId) {
      res.status(400).json({
        status: 400,
        error: 'client_id_required',
        message: 'client_id is required'
      })
      return
    }

    if (!accepted) {
      res.status(400).json({
        status: 400,
        error: 'accepted_required',
        message: 'accepted must be true'
      })
      return
    }

    const consent = setConsentAccepted({
      subjectType: 'web',
      subjectId: clientId,
      source: 'frontend',
      documentUrl: CONSENT_DOCUMENT_URL
    })

    res.json({
      status: 200,
      accepted: true,
      client_id: clientId,
      document_url: consent.document_url,
      accepted_at: consent.accepted_at,
      source: consent.source
    })
  }

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

  router.get('/api/consent', getConsentHandler)
  router.post('/api/consent', saveConsentHandler)
  router.get('/api/consent-status', getConsentHandler)
  router.post('/api/consent-status', saveConsentHandler)
  router.get('/consent', getConsentHandler)
  router.post('/consent', saveConsentHandler)
  router.get('/consent-status', getConsentHandler)
  router.post('/consent-status', saveConsentHandler)

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
