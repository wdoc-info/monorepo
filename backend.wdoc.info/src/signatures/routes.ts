import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { jwtVerify, type JWK } from 'jose';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { AppConfig } from '../config';
import { SimpleRateLimiter } from '../rateLimit';
import { COMMITMENT_PATTERN, decodeUtf8, encoder, jcs, parseJson, verifyJws, type KeyRecord } from './core';
import { KeyResolverService, SignatureError, SignatureService, type Actor } from './services';

export interface SigningConfig { keys: KeyRecord[]; allowedOrigins: string[]; kid?: string; privateJwk?: JWK }
export function loadSigningConfig(): SigningConfig {
  return {
    keys: parseJson(process.env.SIGNING_PUBLIC_KEYS || '[]'),
    allowedOrigins: (process.env.SIGNING_KEY_ORIGINS || 'https://sig.wdoc.info').split(',').map(s => s.trim()),
    kid: process.env.SIGNING_KID,
    privateJwk: process.env.SIGNING_PRIVATE_JWK ? parseJson(process.env.SIGNING_PRIVATE_JWK) : undefined,
  };
}
const digest = z.string().regex(COMMITMENT_PATTERN);
const base = z.object({ requestId: z.string().uuid().length(36), consent: z.literal(true) });
const documentInput = base.extend({ documentCommitment: digest }).strict();
const formInput = base.extend({ documentProof: z.string().max(8192), submissionCommitment: digest }).strict();
const sealInput = base.extend({ documentProof: z.string().max(8192), archiveCommitment: digest }).strict();
const hash = (value: unknown) => createHash('sha256').update(jcs(value)).digest('base64url');
type Receipt = { signatureId: string; jws: string };

/** No archive, manifest, file names, answers or attachments are accepted by this router. */
export function createSignatureRoutes(db: Database, config: AppConfig, signing: SigningConfig) {
  if (signing.privateJwk && (config.jwtSecret === 'dev-jwt-secret' || config.jwtSecret.length < 32)) throw new Error('Signing requires a JWT_SECRET of at least 32 characters.');
  const limiter = new SimpleRateLimiter(60_000, 30);
  const resolver = new KeyResolverService(signing.keys, signing.allowedOrigins);
  const signer = new SignatureService(resolver, signing.kid, signing.privateJwk);
  db.exec(`
    CREATE TABLE IF NOT EXISTS signature_receipts (actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(actor, request_id));
    CREATE TABLE IF NOT EXISTS signature_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, event TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS immutable_signature_events_update BEFORE UPDATE ON signature_events BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
    CREATE TRIGGER IF NOT EXISTS immutable_signature_events_delete BEFORE DELETE ON signature_events BEGIN SELECT RAISE(ABORT, 'append-only journal'); END;
  `);
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', bodyLimit({ maxSize: 16384, onError: c => c.json({ error: { code: 'REQUEST_TOO_LARGE', message: 'Signing accepts commitments only (16 KB maximum).' } }, 413) }));
  app.onError((e, c) => {
    if (e instanceof SignatureError) return c.json({ error: { code: e.code, message: e.message } }, e.status);
    if (e instanceof z.ZodError || e instanceof SyntaxError) return c.json({ error: { code: 'INVALID_REQUEST', message: 'Only the documented commitment fields are accepted.' } }, 400);
    // Never log request bodies or values from validation/cryptographic errors.
    return c.json({ error: { code: 'SIGNATURE_ERROR', message: 'Signature operation failed.' } }, 500);
  });
  app.get('/signing-keys', c => c.json({ keys: resolver.records }));
  app.get('/info/:keyId', c => {
    const key = resolver.records.find(k => new URL(k.kid).pathname === `/info/${c.req.param('keyId')}`);
    if (!key) return c.json({ error: { code: 'KEY_NOT_FOUND', message: 'Key not found.' } }, 404);
    return c.json({ ...key.jwk, kid: key.kid, alg: 'ES256', use: 'sig' });
  });
  app.use('/signatures/*', async (c, next) => {
    try {
      const auth = c.req.header('Authorization');
      if (!auth?.startsWith('Bearer ')) throw new Error();
      const { payload } = await jwtVerify(auth.slice(7), encoder.encode(config.jwtSecret), { algorithms: ['HS256'] });
      if (!payload.sub || typeof payload.email !== 'string') throw new Error();
      c.set('actor', { userId: payload.sub, email: payload.email });
    } catch { return c.json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }, 401); }
    if (!limiter.check(c.get('actor').userId, Date.now()).allowed) return c.json({ error: { code: 'RATE_LIMITED', message: 'Too many signing operations. Try again later.' } }, 429);
    await next();
  });
  async function attest(actor: Actor, kind: 'document' | 'form' | 'seal', input: { requestId: string }, claims: object): Promise<Receipt> {
    const fingerprint = hash({ kind, input });
    const lookup = () => db.query<{ fingerprint: string; receipt: string }, [string, string]>('SELECT fingerprint, receipt FROM signature_receipts WHERE actor = ? AND request_id = ?').get(actor.userId, input.requestId);
    const replay = (row: { fingerprint: string; receipt: string }) => {
      if (row.fingerprint !== fingerprint) throw new SignatureError('IDEMPOTENCY_CONFLICT', 'Request ID was used for different commitments.', 409);
      return JSON.parse(row.receipt) as Receipt;
    };
    const existing = lookup(); if (existing) return replay(existing);
    const signedAt = new Date().toISOString();
    const payload = {
      type: `wdoc-${kind}-signature`, proofMode: 'digest-only', ...claims,
      ...(kind === 'form' ? { mode: 'wdoc-attestation' } : {}),
      signer: { userId: actor.userId, displayName: actor.email }, signedAt,
      evidence: { method: 'authenticated-session', consent: 'wdoc-sign-v1', scope: 'commitment-only' },
    };
    const receipt = { signatureId: crypto.randomUUID(), jws: await signer.sign(kind, payload) };
    return db.transaction(() => {
      const concurrent = lookup(); if (concurrent) return replay(concurrent);
      db.query('INSERT INTO signature_receipts VALUES (?, ?, ?, ?)').run(actor.userId, input.requestId, fingerprint, jcs(receipt));
      const previousHash = db.query<{ hash: string }, [string]>('SELECT hash FROM signature_events WHERE actor = ? ORDER BY sequence DESC LIMIT 1').get(actor.userId)?.hash ?? null;
      const event = { requestId: input.requestId, kind, fingerprint, signatureDigest: hash(receipt), signedAt, previousHash };
      db.query('INSERT INTO signature_events (actor, event, hash) VALUES (?, ?, ?)').run(actor.userId, jcs(event), hash(event));
      return receipt;
    })();
  }
  async function proof(jws: string): Promise<string> {
    const { check, payload } = await verifyJws(jws, 'document', resolver.records);
    if (check.status !== 'valid-trusted' || payload?.proofMode !== 'digest-only') throw new SignatureError('DOCUMENT_NOT_TRUSTED', 'A trusted digest-only document attestation is required.', 403);
    return payload.documentCommitment;
  }
  function json(bytes: Uint8Array): unknown {
    try { return parseJson(decodeUtf8(bytes)); } catch { throw new SignatureError('INVALID_REQUEST', 'Invalid or ambiguous JSON request.'); }
  }
  app.post('/signatures/document', async c => {
    const input = documentInput.parse(json(new Uint8Array(await c.req.arrayBuffer())));
    return c.json(await attest(c.get('actor'), 'document', input, { documentCommitment: input.documentCommitment }));
  });
  app.post('/signatures/form', async c => {
    const input = formInput.parse(json(new Uint8Array(await c.req.arrayBuffer())));
    return c.json(await attest(c.get('actor'), 'form', input, { documentCommitment: await proof(input.documentProof), submissionCommitment: input.submissionCommitment }));
  });
  app.post('/signatures/seal', async c => {
    const input = sealInput.parse(json(new Uint8Array(await c.req.arrayBuffer())));
    return c.json(await attest(c.get('actor'), 'seal', input, { documentCommitment: await proof(input.documentProof), archiveCommitment: input.archiveCommitment }));
  });
  return app;
}
