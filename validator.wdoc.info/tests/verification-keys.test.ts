import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { encoder } from '../src/app/format/core';
import { loadOnlineRegistry, parseRegistry } from '../src/app/validation/verification-keys';
import { verificationPolicy } from '../src/app/config';
import { readVector } from './helpers';
const registry = await readVector('registry.json'), mutations = await readVector('mutations.json');
const online = { keys: [{ ...registry.keys[0], kid: 'https://sig.wdoc.info/info/test' }] };
afterEach(() => mock.restore());
describe('Independent public key policy', () => {
    test('accepts a separately selected local public registry, never keys from an archive', async () => {
        const result = await parseRegistry(encoder.encode(JSON.stringify(registry)), 'trusted-keys.json', 'local');
        expect(result.state).toBe('local');
        expect(result.keys).toHaveLength(2);
        expect(result.source).toBe('trusted-keys.json');
    });
    for (const vector of mutations.registries)
        test(vector.id, async () => {
            const promise = parseRegistry(encoder.encode(JSON.stringify({ keys: vector.keys, allowedOrigins: vector.allowedOrigins })), 'registry.json', 'local');
            if (vector.valid)
                await expect(promise).resolves.toBeDefined();
            else
                await expect(promise).rejects.toThrow();
        });
    test('requires complete local policy and rejects duplicated JSON members and invalid UTF-8', async () => {
        for (const bytes of [encoder.encode(JSON.stringify({ keys: registry.keys })), encoder.encode('[]'), encoder.encode('{"keys":[],"keys":[],"allowedOrigins":[]}'), new Uint8Array([0xc3, 0x28]), new Uint8Array(1000001)])
            await expect(parseRegistry(bytes, 'invalid.json', 'local')).rejects.toThrow();
        await expect(parseRegistry(encoder.encode(JSON.stringify({ ...registry, extra: true })), 'invalid.json', 'local')).rejects.toThrow();
    });
    test('a response cannot broaden the online origin policy', async () => {
        await expect(parseRegistry(encoder.encode(JSON.stringify(registry)), 'remote', 'online')).rejects.toThrow();
        const malformed = { ...online, allowedOrigins: ['http://unsafe.example'] };
        await expect(parseRegistry(encoder.encode(JSON.stringify(malformed)), 'remote', 'online')).rejects.toThrow();
    });
    test('fetches only configured public keys using a credential-free GET', async () => {
        const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(online), { status: 200 }));
        const signal = new AbortController().signal, result = await loadOnlineRegistry(signal);
        expect(result.state).toBe('online');
        expect(result.keys).toHaveLength(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = fetch.mock.calls[0]!;
        expect(url).toBe(verificationPolicy.registryUrl);
        expect(init?.method).toBe('GET');
        expect(init?.body).toBeUndefined();
        expect(init?.credentials).toBe('omit');
        expect(init?.referrerPolicy).toBe('no-referrer');
        expect(init?.redirect).toBe('error');
        expect(init?.signal).toBeDefined();
    });
    test('rejects failed, empty, oversized, and invalid registry responses', async () => {
        const fetch = spyOn(globalThis, 'fetch');
        for (const response of [new Response('unavailable', { status: 503 }), new Response(null), new Response(new Uint8Array(1000001)), new Response('not JSON'), new Response(new Uint8Array([0xc3, 0x28]))]) {
            fetch.mockResolvedValue(response);
            await expect(loadOnlineRegistry()).rejects.toThrow();
        }
    });
    test('rejects private material and invalid curve points even on an approved origin', async () => {
        for (const change of [{ jwk: { ...online.keys[0].jwk, d: 'A'.repeat(43) } }, { jwk: { ...online.keys[0].jwk, x: 'A'.repeat(43), y: 'A'.repeat(43) } }, { trusted: 'true' }]) {
            await expect(parseRegistry(encoder.encode(JSON.stringify({ keys: [{ ...online.keys[0], ...change }] })), 'remote', 'online')).rejects.toThrow();
        }
    });
});
