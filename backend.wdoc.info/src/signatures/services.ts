import { CompactSign, importJWK, type JWK, type KeyLike } from 'jose';
import { createPublicKey } from 'node:crypto';
import { assertKeyRegistry, encoder, jcs, type KeyRecord } from './core';

export class SignatureError extends Error {
  constructor(public code: string, message: string, public status: 400 | 403 | 404 | 409 | 413 | 503 = 400) { super(message); }
}
export class KeyResolverService {
  readonly records: KeyRecord[];
  constructor(records: KeyRecord[], readonly allowedOrigins: string[]) {
    if (!Array.isArray(allowedOrigins)) throw new Error('Missing key origin policy');
    jcs(records); assertKeyRegistry(records, allowedOrigins);
    this.records = records.map(k => {
      createPublicKey({ key: k.jwk, format: 'jwk' });
      return structuredClone(k);
    });
  }
  resolve(kid: string) { return this.records.find(k => k.kid === kid); }
}
export class SignatureService {
  private key?: Promise<KeyLike | Uint8Array>;
  constructor(readonly resolver: KeyResolverService, private readonly kid?: string, private readonly privateJwk?: JWK) {}
  async sign(type: 'document' | 'form' | 'seal', payload: object): Promise<string> {
    const record = this.kid && this.resolver.resolve(this.kid);
    if (!record || record.status !== 'active' || !record.trusted || record.authority !== 'platform' || !this.privateJwk?.d ||
        record.jwk.x !== this.privateJwk.x || record.jwk.y !== this.privateJwk.y || this.privateJwk.crv !== 'P-256' || this.privateJwk.kty !== 'EC' ||
        (record.expiresAt && Date.now() >= Date.parse(record.expiresAt)) || (record.notBefore && Date.now() < Date.parse(record.notBefore))) throw new SignatureError('SIGNING_UNAVAILABLE', 'No authorized platform signing key is configured.', 503);
    this.key ??= importJWK(this.privateJwk, 'ES256');
    return new CompactSign(encoder.encode(jcs(payload))).setProtectedHeader({ alg: 'ES256', typ: `wdoc-${type}+jws`, kid: record.kid }).sign(await this.key);
  }
}
export interface Actor { userId: string; email: string }
