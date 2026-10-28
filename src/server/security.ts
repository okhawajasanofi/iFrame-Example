import type { ErrorRequestHandler, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { ZodError, type ZodType } from 'zod';
import type { Config } from './config';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

export function sendError(res: Response, status: number, code: string, message?: string) {
  res.status(status).json({ error: { code, message: message ?? code } });
}

export function parseBody<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new ApiError(400, 'bad_request', summarize(r.error));
  return r.data;
}

function summarize(e: ZodError): string {
  return e.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ').slice(0, 300);
}

/** Last-resort error handler: always the { error: { code, message } } shape, never a stack trace. */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) return sendError(res, err.status, err.code, err.message);
  if (err?.type === 'entity.too.large') return sendError(res, 413, 'payload_too_large', 'Request body too large');
  if (err?.type === 'entity.parse.failed') return sendError(res, 400, 'bad_json', 'Body is not valid JSON');
  console.error('internal error:', err instanceof Error ? err.message : 'unknown'); // message only: never request data
  sendError(res, 500, 'internal', 'Internal error');
};

export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Helmet for the mainframe, with the CSP from spec section 11. Pattern A forces 'unsafe-inline' and the child origin into script-src. */
export function mainframeHelmet(cfg: Config) {
  return helmet({
    strictTransportSecurity: cfg.production, // plain http on localhost in the demo
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'frame-src': [cfg.childOrigin, 'https:', 'http://info.cern.ch'], // https sites, plus one plain-http demo site (the original WWW page)
        'connect-src': ["'self'", cfg.childOrigin],
        'script-src': ["'self'", "'unsafe-inline'", cfg.childOrigin],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'object-src': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
      },
    },
  });
}

/** Helmet for the child origin. Child pages are arbitrary HTML, so no script CSP here; framing is restricted per response instead. */
export function childHelmet() {
  return helmet({
    contentSecurityPolicy: false,
    frameguard: false, // replaced by CSP frame-ancestors on each page
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // the mainframe loads /sdk.js and child HTML from here
    crossOriginOpenerPolicy: false,
  });
}

export function loginLimiter(cfg: Config) {
  return rateLimit({
    windowMs: 60_000,
    limit: cfg.loginLimit,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: (_req, res) => sendError(res, 429, 'rate_limited', 'Too many sign-in attempts. Try again in a minute.'),
  });
}

/** 120 calls per minute per token (falls back to the IP for requests without a token). */
export function rpcLimiter(cfg: Config) {
  return rateLimit({
    windowMs: 60_000,
    limit: cfg.rpcLimit,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: (req) => {
      const h = req.headers.authorization;
      return h ? 't:' + crypto.createHash('sha256').update(h).digest('hex').slice(0, 24) : 'ip:' + req.ip;
    },
    handler: (_req, res) => sendError(res, 429, 'rate_limited', 'Too many calls. Back off and retry.'),
  });
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

/** CORS origin check that only ever answers the one allowed origin (and sends no CORS headers to anyone else). */
export const onlyOrigin = (allowed: string) => (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => cb(null, origin === allowed);
