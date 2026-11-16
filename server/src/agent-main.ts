import { buildAgent } from './agent.js';

const app = await buildAgent({ sourcesDir: process.env.SOURCES_DIR ?? '/sources', token: process.env.AGENT_TOKEN ?? '' });
await app.listen({ port: Number(process.env.AGENT_PORT ?? 9011), host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void app.close().then(() => process.exit(0)));
