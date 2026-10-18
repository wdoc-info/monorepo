import { describe, expect, test } from 'bun:test';
import { validateDocument } from '../src/app/validation/validate-document';
import { decodeFiles, pack, readVector } from './helpers';
import { encoder } from '../src/app/format/core';
const vectors = (await readVector('positive.json')).cases;
const registry = await readVector('registry.json');
const trust = { state: 'local' as const, source: 'Independent test registry', keys: registry.keys };
describe('Optional embedded Git diagnostics', () => {
  test('unreadable history does not invalidate the original document signature', async () => {
    const files = decodeFiles(vectors.find((vector: any) => vector.id === 'document-signed').files);
    files['.git/HEAD'] = encoder.encode('corrupt optional metadata');
    const report = await validateDocument(await pack(files), trust);
    expect(report.format).toBe('valid');
    expect(report.signatures.results.find(result => result.kind === 'document')?.status).toBe('valid-trusted');
    expect(report.recommendations.find(result => result.id === 'git-history')?.level).toBe('warning');
    expect(report.files.find(file => file.path === '.git/HEAD')?.kind).toBe('history');
  });
  test('reports optional history for a manifestless document without rendering it', async () => {
    const report = await validateDocument(await pack({ 'index.html': encoder.encode('<p>Unsigned</p>'), '.git/HEAD': encoder.encode('corrupt metadata') }));
    expect(report.verdict).toBe('valid'); expect(report.recommendations.some(result => result.id === 'git-history')).toBeTrue();
  });
});
