import { Inflate, deflate } from 'pako';
const encoder = new TextEncoder();
export const objectId = async (bytes: Uint8Array): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
export interface PackedObject { oid: string; wrapped: Uint8Array; compressed: Uint8Array }
/** Decode a pack before handing anything to Git. Both inflation and delta allocation are bounded. */
export async function unpack(bytes: Uint8Array, loose: Map<string, Uint8Array>, budget = { bytes: 0, objects: 0 }): Promise<PackedObject[]> {
  if (bytes.length < 32 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'PACK') throw new Error('Invalid Git pack');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), version = view.getUint32(4), count = view.getUint32(8);
  budget.objects += count;
  if (![2, 3].includes(version) || budget.objects > 10000) throw new Error('Unsupported Git pack');
  const expected = Array.from(bytes.slice(-20), b => b.toString(16).padStart(2, '0')).join('');
  if (await objectId(bytes.slice(0, -20)) !== expected) throw new Error('Git pack checksum mismatch');
  interface Item { start: number; type: number; data: Uint8Array; baseOffset?: number; baseOid?: string; resolved?: PackedObject; depth?: number }
  const items: Item[] = [], offsets = new Map<number, Item>(), resolved = new Map<string, { wrapped: Uint8Array; depth: number }>();
  for (const [oid, wrapped] of loose) resolved.set(oid, { wrapped, depth: 0 });
  let cursor = 12;
  for (let n = 0; n < count; n++) {
    const start = cursor; let byte = bytes[cursor++], type = (byte >> 4) & 7, length = byte & 15, shift = 4;
    while (byte & 128) { if (shift > 28 || cursor >= bytes.length - 20) throw new Error('Invalid Git pack size'); byte = bytes[cursor++]; length += (byte & 127) * 2 ** shift; shift += 7; }
    if (![1, 2, 3, 4, 6, 7].includes(type) || length > 30_000_128) throw new Error('Unsupported Git pack object');
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) {
      byte = bytes[cursor++]; let distance = byte & 127, digits = 0;
      while (byte & 128) { if (++digits > 5) throw new Error('Invalid Git delta offset'); byte = bytes[cursor++]; distance = (distance + 1) * 128 + (byte & 127); }
      baseOffset = start - distance; if (!offsets.has(baseOffset)) throw new Error('Invalid Git delta base');
    }
    if (type === 7) { baseOid = Array.from(bytes.slice(cursor, cursor + 20), b => b.toString(16).padStart(2, '0')).join(''); cursor += 20; }
    const inflate = new Inflate({ chunkSize: 65536 }), chunks: Uint8Array[] = []; let size = 0;
    inflate.onData = (chunk: Uint8Array) => {
      size += chunk.length; budget.bytes += chunk.length;
      if (size > length || budget.bytes > 100_000_000) throw new Error('Decoded Git objects exceed limits');
      chunks.push(chunk);
    };
    if (!inflate.push(bytes.subarray(cursor, bytes.length - 20), true) || inflate.err || size !== length) throw new Error('Invalid compressed Git pack object');
    cursor += (inflate as unknown as { strm: { next_in: number } }).strm.next_in;
    const data = new Uint8Array(size); let position = 0; for (const chunk of chunks) { data.set(chunk, position); position += chunk.length; }
    const item = { start, type, data, baseOffset, baseOid }; items.push(item); offsets.set(start, item);
  }
  if (cursor !== bytes.length - 20) throw new Error('Trailing Git pack data');
  const wrap = (type: string, data: Uint8Array) => { const header = encoder.encode(`${type} ${data.length}\0`), wrapped = new Uint8Array(header.length + data.length); wrapped.set(header); wrapped.set(data, header.length); return wrapped; };
  for (let pass = 0; pass <= 64 && items.some(item => !item.resolved); pass++) {
    let progress = false;
    for (const item of items) {
      if (item.resolved) continue;
      let data = item.data, type = ['', 'commit', 'tree', 'blob', 'tag'][item.type], depth = 0;
      if (item.type >= 6) {
        const parent = item.baseOffset !== undefined ? offsets.get(item.baseOffset) : undefined;
        const base = parent?.resolved ? { wrapped: parent.resolved.wrapped, depth: parent.depth! } : item.baseOid ? resolved.get(item.baseOid) : undefined;
        if (!base) continue;
        depth = base.depth + 1; if (depth > 64) throw new Error('Git delta depth exceeds limits');
        const zero = base.wrapped.indexOf(0), source = base.wrapped.subarray(zero + 1); type = new TextDecoder().decode(base.wrapped.subarray(0, zero)).split(' ')[0];
        let at = 0;
        const integer = () => { let result = 0, shift = 0, byte: number; do { if (at >= data.length || shift > 28) throw new Error('Invalid Git delta integer'); byte = data[at++]; result += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128); return result; };
        if (integer() !== source.length) throw new Error('Invalid Git delta source');
        const resultSize = integer(); budget.bytes += resultSize;
        if (resultSize > 30_000_128 || budget.bytes > 100_000_000) throw new Error('Decoded Git objects exceed limits');
        const result = new Uint8Array(resultSize); let out = 0;
        const take = () => { if (at >= data.length) throw new Error('Truncated Git delta instruction'); return data[at++]; };
        while (at < data.length) {
          const command = data[at++]; let offset = 0, size = 0;
          if (command & 128) {
            for (let bit = 0; bit < 4; bit++) if (command & (1 << bit)) offset += take() * 2 ** (8 * bit);
            for (let bit = 0; bit < 3; bit++) if (command & (1 << (4 + bit))) size += take() * 2 ** (8 * bit);
            if (!size) size = 65536;
            if (!Number.isFinite(offset + size) || offset + size > source.length || out + size > resultSize) throw new Error('Invalid Git delta copy');
            result.set(source.subarray(offset, offset + size), out);
          } else {
            size = command; if (!size || at + size > data.length || out + size > resultSize) throw new Error('Invalid Git delta insert');
            result.set(data.subarray(at, at + size), out); at += size;
          }
          out += size;
        }
        if (out !== resultSize) throw new Error('Incomplete Git delta'); data = result;
      }
      const wrapped = wrap(type, data), oid = await objectId(wrapped);
      item.resolved = { oid, wrapped, compressed: deflate(wrapped) }; item.depth = depth; resolved.set(oid, { wrapped, depth }); progress = true;
    }
    if (!progress && items.some(item => !item.resolved)) throw new Error('Missing or cyclic Git delta base');
  }
  if (items.some(item => !item.resolved)) throw new Error('Git delta depth exceeds limits');
  return items.map(item => item.resolved!);
}
