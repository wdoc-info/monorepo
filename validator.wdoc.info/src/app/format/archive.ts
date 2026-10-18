import JSZip from 'jszip';
import { archiveBudget, decodeUtf8, safePath, type Files } from './core';

export interface ArchiveEntry { name: string; directory: boolean; size: number; compressedSize: number; crc: number; start: number; end: number }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc: number, bytes: Uint8Array): number { for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8); return crc; }
const pathText = (bytes: Uint8Array) => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
function fail(message: string): never { throw new Error(message); }

// Validate original central AND local names before a ZIP library can normalize them.
export function validateArchive(buffer: ArrayBuffer): ArchiveEntry[] {
  const data = new DataView(buffer), bytes = new Uint8Array(buffer);
  let end = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
    if (data.getUint32(i, true) === 0x06054b50 && i + 22 + data.getUint16(i + 20, true) === buffer.byteLength) { end = i; break; }
  }
  if (end < 0) fail('Invalid ZIP directory.');
  const count = data.getUint16(end + 10, true), offset = data.getUint32(end + 16, true), length = data.getUint32(end + 12, true);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true) || data.getUint16(end + 8, true) !== count || count > 11002 || offset + length !== end) fail('Unsupported ZIP archive.');
  const names = new Map<string, boolean>();
  function extras(start: number, size: number, name: string, raw: Uint8Array) {
    const limit = start + size;
    for (let cursor = start; cursor < limit;) {
      if (cursor + 4 > limit) fail('Invalid ZIP extra field.');
      const tag = data.getUint16(cursor, true), size = data.getUint16(cursor + 2, true), next = cursor + 4 + size;
      if (next > limit || tag === 1) fail('Unsupported ZIP extra field.');
      if (tag === 0x7075 && (size < 5 || data.getUint8(cursor + 4) !== 1 || data.getUint32(cursor + 5, true) !== ((crcUpdate(-1, raw) ^ -1) >>> 0) || pathText(bytes.slice(cursor + 9, next)) !== name)) fail('Ambiguous ZIP path.');
      cursor = next;
    }
  }
  const entries: ArchiveEntry[] = [];
  let cursor = offset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.getUint32(cursor, true) !== 0x02014b50) fail('Invalid ZIP entry.');
    const flags = data.getUint16(cursor + 8, true), method = data.getUint16(cursor + 10, true), crc = data.getUint32(cursor + 16, true);
    const compressedSize = data.getUint32(cursor + 20, true), size = data.getUint32(cursor + 24, true);
    const nameLength = data.getUint16(cursor + 28, true), extraLength = data.getUint16(cursor + 30, true), commentLength = data.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & ~0x080e || ![0, 8].includes(method) || (method === 0 && (flags & 6)) || data.getUint16(cursor + 34, true)) fail('Unsupported ZIP entry.');
    const raw = bytes.slice(cursor + 46, cursor + 46 + nameLength);
    if (!(flags & 2048) && raw.some(b => b > 127)) fail('ZIP names must use UTF-8.');
    const name = pathText(raw), directory = name.endsWith('/'), normalized = directory ? name.slice(0, -1) : name;
    if (!safePath(normalized) || names.has(normalized)) fail('Unsafe or duplicate archive path.');
    names.set(normalized, directory);
    const permissions = data.getUint32(cursor + 38, true), unixType = permissions >>> 28;
    if ((unixType && unixType !== (directory ? 4 : 8)) || ((permissions & 16) && !directory) || (directory && (size || compressedSize || crc))) fail('Unsupported ZIP file type.');
    extras(cursor + 46 + nameLength, extraLength, name, raw);
    total += size;
    if (size > 100_000_000 || total > 130_000_000) fail('Archive exceeds limits.');
    const start = data.getUint32(cursor + 42, true);
    if (start + 30 > offset || data.getUint32(start, true) !== 0x04034b50 || data.getUint16(start + 6, true) !== flags || data.getUint16(start + 8, true) !== method) fail('Invalid ZIP local header.');
    const localNameLength = data.getUint16(start + 26, true), localExtraLength = data.getUint16(start + 28, true), body = start + 30 + localNameLength + localExtraLength;
    if (body + compressedSize > offset || localNameLength !== nameLength || raw.some((b, j) => bytes[start + 30 + j] !== b)) fail('Conflicting ZIP local path.');
    extras(start + 30 + localNameLength, localExtraLength, name, raw);
    const local = [data.getUint32(start + 14, true), data.getUint32(start + 18, true), data.getUint32(start + 22, true)];
    if (local.some((v, j) => v !== [crc, compressedSize, size][j] && (!(flags & 8) || v !== 0))) fail('Conflicting ZIP local sizes or CRC.');
    let entryEnd = body + compressedSize;
    if (flags & 8) {
      // Data descriptors may have an optional signature. Test complete candidate values.
      const descriptor = [entryEnd + 4, entryEnd].find(p => p + 12 <= offset && (p === entryEnd || data.getUint32(entryEnd, true) === 0x08074b50) && data.getUint32(p, true) === crc && data.getUint32(p + 4, true) === compressedSize && data.getUint32(p + 8, true) === size);
      if (descriptor === undefined) fail('Invalid ZIP data descriptor.');
      entryEnd = descriptor + 12;
    }
    if (method === 0 && compressedSize !== size) fail('Invalid stored ZIP size.');
    entries.push({ name, directory, size, compressedSize, crc, start, end: entryEnd });
    cursor = next;
  }
  archiveBudget(entries.map(entry => [entry.name, entry.size]));
  if (cursor !== end) fail('Invalid ZIP directory length.');
  for (const name of names.keys()) {
    const segments = name.split('/');
    for (let i = 1; i < segments.length; i++) if (names.get(segments.slice(0, i).join('/')) === false) fail('ZIP file/directory collision.');
  }
  let nextLocal = 0;
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) {
    if (entry.start !== nextLocal) fail('Unindexed or overlapping ZIP data.');
    nextLocal = entry.end;
  }
  if (nextLocal !== offset) fail('Unindexed ZIP data.');
  return entries;
}

// JSZip exposes this stream at runtime, but omits it from JSZipObject's declarations.
type StreamingEntry = JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
export async function readArchive(buffer: ArrayBuffer): Promise<{ files: Files; zip: JSZip }> {
  const entries = validateArchive(buffer);
  const source = await JSZip.loadAsync(buffer, { createFolders: false });
  const files: Files = Object.create(null), zip = new JSZip();
  let total = 0;
  for (const record of entries) {
    if (record.directory) { zip.file(record.name, new Uint8Array(), { dir: true, createFolders: false }); continue; }
    const entry = source.file(record.name);
    if (!entry || (entry.unsafeOriginalName ?? entry.name) !== record.name) fail('ZIP decoder changed an archive name.');
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const stream = (entry as StreamingEntry).internalStream('uint8array');
      let size = 0, crc = -1, stopped = false;
      const chunks: Uint8Array[] = [];
      const stop = (error: Error) => { if (stopped) return; stopped = true; stream.pause(); chunks.length = 0; reject(error); };
      stream.on('data', chunk => {
        if (stopped) return;
        size += chunk.length; total += chunk.length;
        if (size > record.size || total > 130_000_000) { stop(new Error('Expanded archive exceeds limits.')); return; }
        crc = crcUpdate(crc, chunk); chunks.push(chunk);
      }).on('error', stop).on('end', () => {
        if (stopped) return;
        if (size !== record.size || ((crc ^ -1) >>> 0) !== record.crc) { stop(new Error('ZIP size or CRC mismatch.')); return; }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        stopped = true; resolve(bytes);
      }).resume();
    });
    files[record.name] = bytes;
    // Retain only validated expanded data; downstream readers never decompress it again.
    zip.file(record.name, bytes, { binary: true, createFolders: false });
  }
  return { files, zip };
}

export class DocumentLayoutError extends Error {}

// A wrapper is transport packaging only. All document paths are relative to its index.
export async function readDocumentArchive(buffer: ArrayBuffer): Promise<{ files: Files; zip: JSZip; rootPrefix: string }> {
  const source = await readArchive(buffer);
  if (Object.hasOwn(source.files, 'index.html')) {
    decodeUtf8(source.files['index.html']!);
    return { ...source, rootPrefix: '' };
  }
  const entries = Object.values(source.zip.files);
  if (!entries.length) throw new DocumentLayoutError('The archive must contain index.html.');
  const roots = new Set(entries.map(entry => entry.name.split('/')[0]!));
  if (roots.size !== 1 || entries.some(entry => !entry.name.includes('/'))) {
    throw new DocumentLayoutError('Without a root index.html, the archive must contain exactly one enclosing folder and no files beside it.');
  }
  const rootPrefix = `${entries[0]!.name.split('/')[0]}/`;
  if (!Object.hasOwn(source.files, `${rootPrefix}index.html`)) {
    throw new DocumentLayoutError('The enclosing folder must contain index.html directly inside it.');
  }
  decodeUtf8(source.files[`${rootPrefix}index.html`]!);
  const files: Files = Object.create(null), zip = new JSZip();
  for (const entry of entries) {
    const name = entry.name.slice(rootPrefix.length);
    if (!name) continue;
    if (entry.dir) zip.file(name, new Uint8Array(), { dir: true, createFolders: false });
    else {
      files[name] = source.files[entry.name]!;
      zip.file(name, files[name]!, { binary: true, createFolders: false });
    }
  }
  return { files, zip, rootPrefix };
}

/** Optional Git diagnostics never establish identity or invalidate a document proof. */
export function inspectGitHistory(files: Files): { status: 'absent' | 'present' | 'unavailable'; detail: string } {
  const paths = Object.keys(files).filter(path => path.startsWith('.git/'));
  if (!paths.length) return { status: 'absent', detail: 'No embedded history.' };
  try {
    const text = (path: string) => decodeUtf8(files[path]!).trim();
    if (text('.git/HEAD') !== 'ref: refs/heads/main') throw new Error('Expected a main branch HEAD');
    if (!/^[a-f0-9]{40}$/.test(text('.git/refs/heads/main'))) throw new Error('Missing or invalid main branch');
    let objects = 0;
    for (const path of paths) {
      if (path.startsWith('.git/refs/heads/') && !/^[a-f0-9]{40}$/.test(text(path))) throw new Error('Invalid branch reference');
      if (/^\.git\/objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(path)) objects++;
      else if (/^\.git\/objects\/pack\/pack-[a-f0-9]{40}\.pack$/.test(path)) {
        const bytes = files[path]!;
        if (bytes.length < 32 || decodeUtf8(bytes.slice(0, 4)) !== 'PACK') throw new Error('Invalid Git pack header');
        objects += new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8);
      }
    }
    if (!objects || objects > 10000) throw new Error('Git object count exceeds limits or history is empty');
    return { status: 'present', detail: 'Embedded Git history present. Structural headers only were inspected; object graphs, declared authors and dates are not authenticated. The editor performs bounded object decoding before using history.' };
  } catch (error) { return { status: 'unavailable', detail: `History unavailable: ${(error as Error).message}. Document signature verification is independent.` }; }
}
