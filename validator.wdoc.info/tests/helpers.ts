import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { jcs, parseJson, encoder, type Files } from '../src/app/format/core';
export async function readVector(name: string) { return parseJson(await readFile(new URL(`../../spec/vectors/${name}`, import.meta.url), 'utf8')); }
export const decodeFiles = (files: Record<string, string>): Files => Object.fromEntries(Object.entries(files).map(([path, data]) => [path, new Uint8Array(Buffer.from(data, 'base64'))]));
export async function pack(files: Files, prefix = '') {
    const zip = new JSZip();
    for (const [path, data] of Object.entries(files))
        zip.file(prefix + path, data, { createFolders: false });
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}
export function pointerSet(target: any, pointer: string, value: unknown, remove = false) {
    const parts = pointer.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent = target;
    for (const key of parts.slice(0, -1))
        parent = parent[key];
    if (remove)
        delete parent[parts.at(-1)!];
    else
        parent[parts.at(-1)!] = structuredClone(value);
}
export function applyMutation(base: any, mutation: any, registry: any) {
    const files = decodeFiles(base.files), policy = structuredClone(registry), manifest = parseJson(new TextDecoder().decode(files['manifest.json']!));
    let changed = false, pretty = false;
    for (const op of mutation.operations) {
        if (op.op === 'file-set')
            files[op.path] = op.base64 !== undefined ? new Uint8Array(Buffer.from(op.base64, 'base64')) : encoder.encode(op.text);
        else if (op.op === 'file-delete')
            delete files[op.path];
        else if (op.op === 'manifest-set' || op.op === 'manifest-delete') {
            pointerSet(manifest, op.pointer, op.value, op.op === 'manifest-delete');
            changed = true;
        }
        else if (op.op === 'manifest-format') {
            changed = true;
            pretty = true;
        }
        else if (op.op === 'registry-set')
            pointerSet(policy, op.pointer, op.value);
    }
    if (changed)
        files['manifest.json'] = encoder.encode(pretty ? JSON.stringify(manifest, null, 2) + '\n' : jcs(manifest));
    return { files, policy };
}
