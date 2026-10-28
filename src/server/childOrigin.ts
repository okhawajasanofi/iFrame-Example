import express, { type Express } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config';
import { childHelmet, errorHandler, onlyOrigin, sendError } from './security';

/**
 * The child origin (127.0.0.1): serves child-frame HTML (uploaded and sample) and /sdk.js.
 * It never serves the mainframe UI, and it holds no cookies or tokens of the mainframe (different host name = different cookie jar).
 */
export function createChildOrigin(cfg: Config): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(childHelmet());
  app.use(cors({ origin: onlyOrigin(cfg.mainOrigin), credentials: false, methods: ['GET', 'HEAD', 'OPTIONS'] })); // only the mainframe may read these cross-origin

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/sdk.js', (_req, res) => {
    res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(path.join(cfg.distDir, 'sdk', 'sdk.js'));
  });

  app.get('/c/:file', (req, res) => {
    const file = String(req.params.file);
    if (!/^[a-z0-9][a-z0-9-]{1,60}\.html$/.test(file)) return sendError(res, 404, 'not_found', 'Not found');
    const candidates = [path.join(cfg.uploadsDir, file), path.join(cfg.samplesDir, file)];
    const found = candidates.find((f) => fs.existsSync(f));
    if (!found) return sendError(res, 404, 'not_found', 'Not found');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', `frame-ancestors ${cfg.mainOrigin}`); // only the mainframe may frame child pages
    res.setHeader('Cache-Control', 'no-cache');
    res.send(fs.readFileSync(found));
  });

  app.use((_req, res) => sendError(res, 404, 'not_found', 'Not found'));
  app.use(errorHandler);
  return app;
}
