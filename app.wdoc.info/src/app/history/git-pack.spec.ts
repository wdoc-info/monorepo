import { deflate } from 'pako';
import { objectId, unpack } from './git-pack';
const encoder = new TextEncoder();
const concat = (...parts: Uint8Array[]): Uint8Array => { const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; } return bytes; };
const oidBytes = (oid: string) => Uint8Array.from(oid.match(/../g)!, value => parseInt(value, 16));
function header(type: number, size: number): Uint8Array { const bytes = [(type << 4) | (size & 15)]; size >>>= 4; while (size) { bytes[bytes.length - 1] |= 128; bytes.push(size & 127); size >>>= 7; } return new Uint8Array(bytes); }
async function pack(...objects: Uint8Array[]): Promise<Uint8Array> { const prefix = new Uint8Array([80, 65, 67, 75, 0, 0, 0, 2, 0, 0, 0, objects.length]), body = concat(prefix, ...objects); return concat(body, oidBytes(await objectId(body))); }
describe('Bounded Git pack decoding', () => {
  it('reconstructs a reference delta even when its base appears later in the pack', async () => {
    const base = encoder.encode('hello'), oid = await objectId(encoder.encode('blob 5\0hello'));
    const delta = new Uint8Array([5, 11, 0x90, 5, 6, ...encoder.encode(' world')]);
    const bytes = await pack(concat(header(7, delta.length), oidBytes(oid), deflate(delta)), concat(header(3, base.length), deflate(base)));
    const result = await unpack(bytes, new Map());
    expect(new TextDecoder().decode(result[0].wrapped)).toBe('blob 11\0hello world');
  });
  it('reconstructs an offset delta and rejects malformed copy instructions', async () => {
    const base = encoder.encode('hello'), first = concat(header(3, base.length), deflate(base));
    const delta = new Uint8Array([5, 6, 0x90, 5, 1, 33]);
    const result = await unpack(await pack(first, concat(header(6, delta.length), new Uint8Array([first.length]), deflate(delta))), new Map());
    expect(new TextDecoder().decode(result[1].wrapped)).toBe('blob 6\0hello!');
    const bad = new Uint8Array([5, 1, 0x90, 10]);
    await expectAsync(unpack(await pack(first, concat(header(6, bad.length), new Uint8Array([first.length]), deflate(bad))), new Map())).toBeRejected();
  });
  it('stops inflation exceeding the declared size and rejects missing delta bases', async () => {
    await expectAsync(unpack(await pack(concat(header(3, 1), deflate(new Uint8Array(200000)))), new Map())).toBeRejected();
    const delta = new Uint8Array([0, 0]);
    await expectAsync(unpack(await pack(concat(header(7, 2), new Uint8Array(20), deflate(delta))), new Map())).toBeRejectedWithError('Missing or cyclic Git delta base');
  });
  it('enforces a shared decoding budget across multiple packs', async () => {
    const bytes = await pack(concat(header(3, 1), deflate(new Uint8Array([1]))));
    await expectAsync(unpack(bytes, new Map(), { bytes: 100_000_000, objects: 0 })).toBeRejectedWithError('Decoded Git objects exceed limits');
    await expectAsync(unpack(bytes, new Map(), { bytes: 0, objects: 10000 })).toBeRejectedWithError('Unsupported Git pack');
  });
  it('checks pack checksums before reading objects', async () => {
    const bytes = await pack(concat(header(3, 1), deflate(new Uint8Array([1])))); bytes[bytes.length - 1] ^= 1;
    await expectAsync(unpack(bytes, new Map())).toBeRejectedWithError('Git pack checksum mismatch');
  });
});
