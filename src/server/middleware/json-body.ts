import express, { type RequestHandler } from 'express'

// Default JSON body parser for the whole app. The limit is kept small to cap
// DoS amplification; routers that need bigger payloads mount their own
// express.json() with a larger limit.
//
// v1.377.2: /api/admin is skipped because adminRouter mounts its own 8 MB
// parser for theme logos, product icons and Flight Deck screenshots. Before
// this skip, this parser ran first and answered 413 for anything over 256 KB,
// so the router's larger limit never applied and a ~200 KB logo (about
// 270 KB once base64'd into JSON) could not be saved.
export const DEFAULT_JSON_LIMIT = '256kb'
// /api/webhooks/criteriaiq and /api/webhooks/gong read their raw body, since
// the signature covers the exact bytes the sender sent (v1.450.0, v1.456.0).
const OWN_PARSER_PREFIXES = ['/api/admin', '/api/webhooks/criteriaiq', '/api/webhooks/gong']

export function defaultJsonBody(): RequestHandler {
  const parser = express.json({ limit: DEFAULT_JSON_LIMIT })
  return (req, res, next) => {
    // A GET or HEAD never carries a body the app reads. Parsing one let a
    // body teamId steer the role checks while the handler read the query
    // (security audit H1, v1.422.0).
    if (req.method === 'GET' || req.method === 'HEAD') { next(); return }
    const path = req.path
    if (OWN_PARSER_PREFIXES.some(p => path === p || path.startsWith(`${p}/`))) { next(); return }
    parser(req, res, next)
  }
}
