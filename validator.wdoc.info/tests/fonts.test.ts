import { describe, expect, test, spyOn } from 'bun:test';
import { encoder, inventory, jcs, runtimePath, type Files } from '../src/app/format/core';
import { validateDocument } from '../src/app/validation/validate-document';
import { pack, readVector } from './helpers';

const vectors = (await readVector('fonts.json')).cases;
describe('External font conformance stays offline', () => {
  for (const vector of vectors) test(vector.id, async () => {
    const files: Files = Object.fromEntries(Object.entries(vector.files).map(([path, text]) => [path, encoder.encode(text as string)]));
    const manifest = { manifestVersion:'0.1',meta:{docId:'font-test',appVersion:'test',createdAt:'2026-10-18T00:00:00.000Z',contentUpdatedAt:'2026-10-18T00:00:00.000Z'},content:{hashAlgorithm:'SHA-256',files:await inventory(Object.fromEntries(Object.entries(files).filter(([path]) => !runtimePath(path)))),externalFonts:vector.externalFonts},runtime:{submissions:{},revisions:[]},signatures:{document:[],forms:[]} };
    files['manifest.json'] = encoder.encode(jcs(manifest));
    const fetcher = spyOn(globalThis,'fetch').mockRejectedValue(new Error('No font network access'));
    try {
      const report = await validateDocument(await pack(files));
      expect(fetcher).not.toHaveBeenCalled();
      expect(report.format).toBe(vector.valid && vector.cacheStatus !== 'invalid-cache' ? 'valid' : 'invalid');
      if (vector.id === 'pinned-remote-font') expect(report.recommendations.some(check => check.title === 'External font availability not checked')).toBe(true);
    } finally { fetcher.mockRestore(); }
  });
});
