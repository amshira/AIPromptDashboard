import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerAdminApi } from './api/admin.js';
import { registerDataApi } from './api/data.js';
import { registerInstallApi } from './api/install.js';
import { registerPanelsApi } from './api/panels.js';
import { registerServersApi } from './api/servers.js';
import { ensureAdmin, ensureSecret, registerAuth } from './auth.js';
import { Config } from './config.js';
import { Db } from './db/index.js';

// Everything is served from here; inline styles stay allowed for chart and layout style attributes.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export async function buildApp(db: Db, cfg: Config, opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? true,
    trustProxy: cfg.trustProxy,
    bodyLimit: 1024 * 1024,
  });
  await app.register(fastifyCookie);

  await ensureAdmin(db, cfg, app.log);
  const secret = await ensureSecret(db, cfg);
  registerAuth(app, db, cfg, secret);

  app.get('/healthz', async () => {
    await db.query('SELECT 1');
    return { ok: true, version: cfg.version };
  });

  registerDataApi(app, db, cfg.sourcesDir);
  registerAdminApi(app, db, cfg.sourcesDir, cfg.version);
  registerServersApi(app, db, cfg.sourcesDir, cfg.agentBinDir);
  registerPanelsApi(app, db, cfg.sourcesDir, secret);
  registerInstallApi(app, db, cfg);

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', CSP);
    reply.header('cross-origin-opener-policy', 'same-origin');
    reply.header('cross-origin-resource-policy', 'same-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (cfg.cookieSecure) reply.header('strict-transport-security', 'max-age=31536000');
    return payload;
  });

  if (existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, {
      root: cfg.webDir,
      wildcard: false,
      maxAge: '1h',
      // index.html names the current bundle: always revalidate it, or a deploy shows up only an hour later
      setHeaders: (res, path) => path.endsWith('.html') && res.header('cache-control', 'no-cache'),
    });
    // SPA: any non-API GET falls back to index.html; a missing hashed asset is a real 404, not HTML served as JS/CSS
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/') && !req.url.startsWith('/install/')) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }
  return app;
}
