import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Config } from '../config.js';
import { Db } from '../db/index.js';
import { agentFetch, AgentConn } from '../ingest/reader.js';
import { discoverRemote, syncSource } from '../ingest/sync.js';
import { cmpVersion, maybeUpdateAgent, MIN_SELF_UPDATE, readAgentExe } from '../ingest/agentUpdate.js';
import { AGENT_LISTEN_PORT, packAgentZip } from './agent-pack.js';
import { intOrNull } from './util.js';

/*
 * Install of the Windows agent as a Windows service, without running the agent exe:
 *
 *   The dashboard shows a PowerShell snippet. It downloads a zip (exe + config + cert), extracts it
 *   to Program Files, then registers the service with sc.exe. pd-agent.exe is never launched by the
 *   installer; SCM starts it later.
 *
 * Without a valid link every /install/ URL is an empty 404.
 */

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
const notFound = (reply: FastifyReply) => reply.code(404).header('cache-control', 'no-store').send();

// the current agent exe (path, size, sha-256, embedded version); cached, recomputed only when the file changes
const exeInfo = (dir: string) => readAgentExe(dir);

/** A pairing code as `pd-agent pairing` prints it. */
const pairingSchema = z.object({
  host: z.string().max(64),
  port: z.number().int().min(1).max(65535),
  prefix: z.string().regex(/^[a-z0-9]{16,64}$/i),
  secret: z.string().regex(/^[0-9a-f]{64,128}$/i),
  cert: z.string().regex(/^[0-9a-f]{64}$/i),
});
export function readPairing(code: string) {
  const m = /^pda1\.([A-Za-z0-9_-]{20,2000})$/.exec(code.trim());
  if (!m) return null;
  try {
    const p = pairingSchema.safeParse(JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

// only private (RFC 1918) IPv4 addresses are tried: an install link can never make the dashboard reach outside
export function privateV4(a: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [x, y] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((n) => Number(n) > 255)) return false;
  return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
}

const shortName = (host: string) =>
  host
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'pc';

const enrollBody = z.object({
  code: z.string().max(4000),
  host: z.string().trim().max(64).optional(),
  addresses: z.array(z.string().max(45)).max(16).default([]),
});
const linkBody = z.object({
  hours: z.number().int().min(1).max(168).default(24),
  origin: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(u.replace(/\/+$/, '')), 'bad_origin')
    .transform((u) => u.replace(/\/+$/, '')),
});

/** PowerShell the admin pastes. It never launches pd-agent.exe; sc.exe registers the service. */
function installCommand(base: string, token: string, sha: string, allow: string): string {
  const zipUrl = `${base}/install/pd-agent.zip?t=${token}`;
  const enroll = `${base}/install/enroll`;
  const port = String(AGENT_LISTEN_PORT);
  const body = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Dest = Join-Path $env:ProgramFiles 'PDAgent'
$Zip = Join-Path $env:TEMP 'pd-agent.zip'
Write-Host 'Downloading PD Agent package ...'
curl.exe -L --fail --progress-bar -o $Zip '${zipUrl}'
cmd.exe /c "sc stop PDAgent >nul 2>&1"
cmd.exe /c "taskkill /F /IM pd-agent.exe >nul 2>&1"
Start-Sleep -Seconds 1
cmd.exe /c "sc delete PDAgent >nul 2>&1"
Start-Sleep -Seconds 1
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Expand-Archive -Force -Path $Zip -DestinationPath $Dest
$exe = Join-Path $Dest 'pd-agent.exe'
if ((Get-FileHash -Algorithm SHA256 -Path $exe).Hash.ToLower() -ne '${sha}') {
  Remove-Item -Recurse -Force $Dest
  throw 'SHA-256 mismatch; the Windows service was not installed.'
}
Unblock-File -Path $exe
icacls $Dest /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' /grant:r '*S-1-5-32-544:(OI)(CI)F' | Out-Null
netsh advfirewall firewall delete rule name='PD Agent' | Out-Null
netsh advfirewall firewall add rule name='PD Agent' dir=in action=allow protocol=TCP localport=${port} remoteip=${allow} program=$exe enable=yes | Out-Null
cmd.exe /c ('sc create PDAgent binPath= "' + $exe + '" start= auto DisplayName= "PD Agent"')
sc.exe description PDAgent "Read-only agent for the prompt dashboard." | Out-Null
sc.exe failure PDAgent reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
sc.exe start PDAgent
Start-Sleep -Seconds 2
$st = sc.exe query PDAgent | Out-String
if ($st -notmatch 'RUNNING') { throw "PD Agent service did not start. Allow $exe in Kaspersky and retry." }
$pair = Get-Content (Join-Path $Dest 'pairing.json') -Raw | ConvertFrom-Json
$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -ExpandProperty IPAddress)
$body = @{ code = $pair.code; host = $env:COMPUTERNAME; addresses = @($ips) } | ConvertTo-Json -Compress
$json = Join-Path $env:TEMP 'pd-enroll.json'
[System.IO.File]::WriteAllText($json, $body, (New-Object System.Text.UTF8Encoding $false))
curl.exe -sS -f -X POST -H "content-type: application/json" -H "x-install-token: ${token}" --data-binary "@$json" "${enroll}"
Write-Host "PD Agent Windows service is running on port ${port}."
`;
  return `$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
  Write-Host 'Windows will ask permission to register the PD Agent service.'
  $setup = Join-Path $env:TEMP 'pd-agent-setup.ps1'
  @'
${body}
'@ | Set-Content -Encoding UTF8 $setup
  Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @('-NoProfile','-File',$setup)
} else {
${body.split('\n').map((l) => '  ' + l).join('\n')}
}
`;
}

export function registerInstallApi(app: FastifyInstance, db: Db, cfg: Pick<Config, 'agentBinDir' | 'pcAgentAllow' | 'sourcesDir'>) {
  const allowOk = /^[0-9a-fA-F:.,/]{3,200}$/.test(cfg.pcAgentAllow);

  /** The link a token belongs to, if it is still valid. */
  const linkOf = async (token: unknown) => {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    const r = await db.query('SELECT id, base_url FROM install_links WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()', [tokenHash(token)]);
    return (r.rows[0] as { id: number; base_url: string } | undefined) ?? null;
  };

  // ---------- admin (behind the login, like every /api/ route) ----------

  app.get('/api/pcs/install-links', async () => {
    const exe = await exeInfo(cfg.agentBinDir);
    const r = await db.query(
      `SELECT id, base_url, created_at, expires_at, uses, last_used_at FROM install_links
       WHERE revoked_at IS NULL AND expires_at > now() ORDER BY id DESC`,
    );
    return { links: r.rows, ready: !!exe && allowOk, exe: exe ? { size: exe.size, sha256: exe.sha, version: exe.version } : null, allow: cfg.pcAgentAllow };
  });

  // Push the current agent exe to one paired Windows PC. The agent stages it and a Windows Scheduled Task
  // copies it into place and restarts the service. Agents older than the first updatable build cannot take it.
  app.post('/api/pcs/:id/update-agent', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    const srv = (await db.query('SELECT id, url, token, cert_sha256 AS cert, info FROM servers WHERE id=$1', [id])).rows[0];
    if (!srv) return reply.code(404).send({ error: 'not_found' });
    if (!srv.cert) return reply.code(409).send({ error: 'not_a_windows_agent' });
    const exe = exeInfo(cfg.agentBinDir);
    if (!exe?.version) return reply.code(409).send({ error: 'no_agent_exe' });
    const running = (srv.info as { agent?: { version?: string } } | null)?.agent?.version;
    if (!running) return reply.code(409).send({ error: 'agent_version_unknown' });
    if (cmpVersion(running, MIN_SELF_UPDATE) < 0) return reply.code(409).send({ error: 'agent_too_old' });
    if (cmpVersion(exe.version, running) <= 0) return { ok: true, version: exe.version, already: true };
    try {
      await maybeUpdateAgent(db, srv, cfg.agentBinDir, running, true);
      return { ok: true, version: exe.version };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });

  app.post('/api/pcs/install-links', async (req, reply) => {
    const b = linkBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'invalid' });
    if (!allowOk) return reply.code(409).send({ error: 'no_pc_allow' });
    const exe = await exeInfo(cfg.agentBinDir);
    if (!exe) return reply.code(409).send({ error: 'no_agent_exe' });
    const token = randomBytes(32).toString('hex');
    const r = await db.query(
      `INSERT INTO install_links(token_hash, base_url, expires_at) VALUES($1,$2, now() + make_interval(hours => $3)) RETURNING id, expires_at`,
      [tokenHash(token), b.data.origin, b.data.hours],
    );
    const command = installCommand(b.data.origin, token, exe.sha, cfg.pcAgentAllow);
    const url = `${b.data.origin}/install/pd-agent.zip?t=${token}`;
    return { id: r.rows[0].id, expires_at: r.rows[0].expires_at, url, command };
  });

  app.delete('/api/pcs/install-links/:id', async (req, reply) => {
    const id = intOrNull((req.params as { id: string }).id);
    if (!id) return reply.code(400).send({ error: 'bad_id' });
    await db.query('UPDATE install_links SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
    return { ok: true };
  });

  // ---------- public, only with a valid link ----------

  app.get('/install/windows.ps1', async (req, reply) => {
    const token = (req.query as { t?: string }).t;
    const link = await linkOf(token);
    const exe = await exeInfo(cfg.agentBinDir);
    if (!link || !exe || !allowOk) return notFound(reply);
    return reply
      .header('content-type', 'text/plain; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(installCommand(link.base_url, token as string, exe.sha, cfg.pcAgentAllow));
  });

  app.get('/install/pd-agent.zip', async (req, reply) => {
    const token = (req.query as { t?: string }).t;
    const link = await linkOf(token);
    const exe = await exeInfo(cfg.agentBinDir);
    if (!link || !exe || !allowOk) return notFound(reply);
    const packed = packAgentZip(exe.file, cfg.pcAgentAllow.split(',').map((s) => s.trim()).filter(Boolean));
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="pd-agent.zip"')
      .header('content-length', packed.zip.length)
      .header('cache-control', 'no-store')
      .send(packed.zip);
  });

  app.get('/install/pd-agent.exe', async (req, reply) => {
    const link = await linkOf((req.query as { t?: string }).t);
    const exe = await exeInfo(cfg.agentBinDir);
    if (!link || !exe) return notFound(reply);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', 'attachment; filename="pd-agent.exe"')
      .header('content-length', exe.size)
      .header('cache-control', 'no-store')
      .send(createReadStream(exe.file));
  });

  app.post('/install/enroll', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    const link = await linkOf(req.headers['x-install-token']);
    if (!link) return notFound(reply);
    const b = enrollBody.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: 'invalid' });
    const p = readPairing(b.data.code);
    if (!p) return reply.code(400).send({ error: 'bad_pairing' });

    // where the dashboard can reach this PC: the IPs it reported, and the address the request came from
    const candidates = [...new Set([...b.data.addresses.map((a) => a.trim()), req.ip.replace(/^::ffff:/, '')])].filter(privateV4);
    if (!candidates.length) return reply.code(422).send({ error: 'no_private_address' });
    const connOf = (a: string): AgentConn => ({ url: `https://${a}:${p.port}/${p.prefix}`, token: p.secret.toLowerCase(), cert: p.cert.toLowerCase() });
    let address: string;
    try {
      address = await Promise.any(
        candidates.map(async (a) => {
          await agentFetch(connOf(a), 'sources');
          return a;
        }),
      );
    } catch {
      return reply.code(422).send({ error: `the dashboard cannot reach this PC on port ${p.port} (tried ${candidates.join(', ')}); check the firewall` });
    }
    const conn = connOf(address);

    // the same agent again (a reinstall keeps its key and certificate): just update where it is
    const host = (b.data.host || p.host || 'pc').slice(0, 64);
    const same = await db.query('SELECT id, name FROM servers WHERE cert_sha256=$1', [conn.cert]);
    let id: number;
    let name: string;
    if (same.rowCount) {
      ({ id, name } = same.rows[0]);
      await db.query('UPDATE servers SET url=$2, token=$3, enabled=true WHERE id=$1', [id, conn.url, conn.token]);
    } else {
      const base = shortName(host);
      name = base;
      for (let i = 2; (await db.query('SELECT 1 FROM servers WHERE name=$1', [name])).rowCount; i++) name = `${base}-${i}`;
      const r = await db.query('INSERT INTO servers(name,label,url,token,cert_sha256) VALUES($1,$2,$3,$4,$5) RETURNING id', [name, host, conn.url, conn.token, conn.cert]);
      id = r.rows[0].id;
    }
    await db.query('UPDATE install_links SET uses=uses+1, last_used_at=now() WHERE id=$1', [link.id]);
    const sources = await discoverRemote(db, id).catch(() => 0);
    const { rows } = await db.query('SELECT id FROM sources WHERE server_id=$1 AND enabled', [id]);
    for (const s of rows) void syncSource(db, cfg.sourcesDir, s.id, 'manual').catch(() => undefined);
    req.log.info({ pc: name, address }, 'pc enrolled through an install link');
    return { ok: true, name, address, sources };
  });
}
