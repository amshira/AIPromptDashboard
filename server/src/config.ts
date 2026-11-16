import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  databaseUrl: string;
  sourcesDir: string;
  webDir: string;
  adminPassword: string;
  resetAdminPassword: boolean;
  sessionSecret: string;
  cookieSecure: boolean;
  /** only behind a reverse proxy: otherwise anyone can pick their own IP with X-Forwarded-For and dodge the login lockout */
  trustProxy: boolean;
  version: string;
  /** folder holding pd-agent.exe, served to PCs that run an install link (see api/install.ts) */
  agentBinDir: string;
  /** the address the dashboard reaches PCs from, as they see it: written into each PC's agent allowlist */
  pcAgentAllow: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 9010),
    databaseUrl: env.DATABASE_URL ?? 'postgres://prompt:prompt@localhost:5432/prompt',
    sourcesDir: env.SOURCES_DIR ?? '/sources',
    webDir: env.WEB_DIR ?? join(here, '../../web/dist'),
    adminPassword: env.ADMIN_PASSWORD ?? '',
    resetAdminPassword: /^(1|true|yes)$/i.test(env.RESET_ADMIN_PASSWORD ?? ''),
    sessionSecret: env.SESSION_SECRET ?? '',
    cookieSecure: /^(1|true|yes)$/i.test(env.COOKIE_SECURE ?? ''),
    trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? ''),
    version: env.APP_VERSION ?? '1.0.0',
    agentBinDir: env.AGENT_BIN_DIR ?? join(here, '../../agent-bin'),
    pcAgentAllow: (env.PC_AGENT_ALLOW ?? '').trim(),
  };
}
