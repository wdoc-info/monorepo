// Ephemeral, in-memory signing authority used only by the Playwright integration test.
import { generateKeyPair, exportJWK } from 'jose';
import { createApp } from '../app';
import { initDatabase } from '../db';
import { loadConfig } from '../config';
import { signJwt } from '../auth/jwt';

const pair = await generateKeyPair('ES256', { extractable: true });
const kid = 'https://sig.wdoc.info/info/e2e-key';
const config = { ...loadConfig(), jwtSecret: crypto.randomUUID() + crypto.randomUUID() };
const app = createApp({ config, db: initDatabase(':memory:'), signing: { kid, privateJwk: await exportJWK(pair.privateKey), allowedOrigins: ['https://sig.wdoc.info'], keys: [{ kid, jwk: await exportJWK(pair.publicKey), trusted: true, status: 'active', authority: 'platform', owner: 'wdoc test authority' }] } });
const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: app.fetch });
const user = { id: 'e2e-user', email: 'signer@example.com' };
const peer = { id: 'e2e-peer', email: 'peer@example.com' };
console.log(JSON.stringify({ url: server.url.toString(), session: { token: await signJwt({ sub: user.id, email: user.email }, config.jwtSecret, 3600), user }, peerSession: { token: await signJwt({ sub: peer.id, email: peer.email }, config.jwtSecret, 3600), user: peer } }));
