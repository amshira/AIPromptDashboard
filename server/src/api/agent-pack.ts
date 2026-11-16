import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { zipStore } from './zip.js';

export const AGENT_LISTEN_PORT = 14538;

const derLen = (n: number) => {
  if (n < 128) return Buffer.from([n]);
  if (n < 256) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
};
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (body: Buffer) => tlv(0x30, body);
const oid = (bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
const intPos = (b: Buffer) => {
  let v = Buffer.from(b);
  while (v.length > 1 && v[0] === 0) v = v.subarray(1);
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
};
const bitStr = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const ctx0 = (b: Buffer) => tlv(0xa0, b);

const ecdsaSha256 = seq(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));

function timeDer(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  return tlv(0x18, Buffer.from(s, 'ascii'));
}

function cn(name: string) {
  return seq(set(seq(Buffer.concat([oid([0x55, 0x04, 0x03]), utf8(name)]))));
}
function set(body: Buffer) {
  return tlv(0x31, body);
}

export function selfSignedAgentCert() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  const cnName = 'pd' + createHash('sha256').update(spki).digest('hex').slice(0, 10);
  const serial = createHash('sha256').update(spki).digest().subarray(0, 16);
  const now = new Date();
  const tbs = seq(
    Buffer.concat([
      ctx0(intPos(Buffer.from([2]))),
      intPos(serial),
      ecdsaSha256,
      cn(cnName),
      seq(Buffer.concat([timeDer(new Date(now.getTime() - 3600_000)), timeDer(new Date(now.getTime() + 20 * 365 * 24 * 3600_000))])),
      cn(cnName),
      spki,
    ]),
  );
  const sig = sign('sha256', tbs, privateKey);
  const der = seq(Buffer.concat([tbs, ecdsaSha256, bitStr(sig)]));
  const pem = (type: string, data: Buffer) => `-----BEGIN ${type}-----\n${data.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END ${type}-----\n`;
  const keyPem = privateKey.export({ type: 'sec1', format: 'pem' }) as string;
  const certPem = pem('CERTIFICATE', der);
  const fingerprint = createHash('sha256').update(der).digest('hex');
  return { certPem, keyPem, fingerprint };
}

export function pairingCode(p: { host: string; port: number; prefix: string; secret: string; cert: string }) {
  return 'pda1.' + Buffer.from(JSON.stringify({ v: 1, ...p }), 'utf8').toString('base64url');
}

export function packAgentZip(exeFile: string, allow: string[]) {
  const { certPem, keyPem, fingerprint } = selfSignedAgentCert();
  const prefix = randomBytes(12).toString('hex');
  const secretHex = randomBytes(32).toString('hex');
  const config = {
    port: AGENT_LISTEN_PORT,
    prefix,
    secret: secretHex,
    allow,
    settleSeconds: 90,
  };
  const code = pairingCode({ host: 'pc', port: config.port, prefix, secret: secretHex, cert: fingerprint });
  const exe = readFileSync(exeFile);
  return {
    zip: zipStore([
      { name: 'pd-agent.exe', data: exe },
      { name: 'config.json', data: Buffer.from(JSON.stringify(config, null, 2) + '\n') },
      { name: 'agent.crt', data: Buffer.from(certPem) },
      { name: 'agent.key', data: Buffer.from(keyPem) },
      { name: 'pairing.json', data: Buffer.from(JSON.stringify({ code, port: config.port }) + '\n') },
    ]),
    fingerprint,
    port: config.port,
  };
}
