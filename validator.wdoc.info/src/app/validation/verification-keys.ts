import { importJWK } from 'jose';
import { assertKeyRegistry, decodeUtf8, isRecord, parseJson, type KeyRecord } from '../format/core';
import { verificationPolicy } from '../config';
export interface TrustContext {
    state: 'not-loaded' | 'online' | 'local' | 'unavailable';
    source: string;
    keys: KeyRecord[];
    detail?: string;
}
export function emptyTrust(detail?: string): TrustContext { return { state: 'not-loaded', source: 'No key registry', keys: [], ...(detail ? { detail } : {}) }; }
const maxRegistryBytes = 1000000;
export async function parseRegistry(bytes: Uint8Array, source: string, state: 'online' | 'local'): Promise<TrustContext> {
    if (bytes.length > maxRegistryBytes)
        throw new Error('Public key registries are limited to 1 MB in this validator.');
    const registry: unknown = parseJson(decodeUtf8(bytes));
    if (!isRecord(registry) || !Object.hasOwn(registry, 'keys') || Object.keys(registry).some(k => !['keys', 'allowedOrigins'].includes(k)))
        throw new Error('Expected a public registry object containing keys and optional allowedOrigins.');
    if (state === 'local' && !Object.hasOwn(registry, 'allowedOrigins'))
        throw new Error('Local trusted registries must explicitly include allowedOrigins.');
    if (Object.hasOwn(registry, 'allowedOrigins'))
        assertKeyRegistry([], registry['allowedOrigins']);
    const origins = state === 'online' ? verificationPolicy.allowedOrigins : registry['allowedOrigins'] as string[];
    assertKeyRegistry(registry['keys'], origins);
    await Promise.all(registry['keys'].map(key => importJWK(key.jwk, 'ES256')));
    return { state, source, keys: registry['keys'] };
}
export async function loadOnlineRegistry(signal?: AbortSignal): Promise<TrustContext> {
    // This is the only network operation in the application. No document data enters it.
    const response = await fetch(verificationPolicy.registryUrl, { method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    if (!response.ok)
        throw new Error(`The public key registry returned HTTP ${response.status}.`);
    const reader = response.body?.getReader();
    if (!reader)
        throw new Error('The public key registry response is empty.');
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            total += part.value.length;
            if (total > maxRegistryBytes)
                throw new Error('Public key registries are limited to 1 MB in this validator.');
            chunks.push(part.value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    return parseRegistry(bytes, 'Configured wdoc authority', 'online');
}
