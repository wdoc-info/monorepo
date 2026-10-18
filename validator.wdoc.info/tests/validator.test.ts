import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { CompactSign, generateKeyPair, exportJWK } from 'jose';
import { validateDocument } from '../src/app/validation/validate-document';
import { emptyTrust } from '../src/app/validation/verification-keys';
import { commitment, documentDigest, encoder, inventory, jcs, newNonce, parseJson, type Files, type Manifest } from '../src/app/format/core';
import { applyMutation, decodeFiles, pack, readVector } from './helpers';
const positive = (await readVector('positive.json')).cases;
const registry = await readVector('registry.json');
const mutations = await readVector('mutations.json');
const trust = { state: 'local' as const, source: 'Independent public test registry', keys: registry.keys };
const layouts = (await readVector('layouts.json')).cases;
describe('Normative archive and layout vectors', () => {
    for (const vector of positive)
        for (const prefix of ['', 'Report/'])
            test(`${vector.id} ${prefix || 'ZIP root'}`, async () => {
                const report = await validateDocument(await pack(decodeFiles(vector.files), prefix), trust);
                expect(report.format).toBe('valid');
                expect(report.verdict).toBe('valid');
                expect(report.rootPrefix).toBe(prefix);
                expect(report.documentDigest).toBe(vector.expected.documentDigest);
                for (const [kind, key] of [['document', 'document'], ['form', 'forms'], ['revision', 'revisions'], ['seal', 'seals']])
                    expect(report.signatures.results.filter(r => r.kind === kind).map(r => r.status)).toEqual(vector.expected[key]);
                if (vector.id === 'two-seals')
                    expect(report.signatures.results.filter(r => r.outcome === 'obsolete')).toHaveLength(1);
                if (vector.id === 'editable-draft')
                    expect(report.recommendations.some(r => r.id.startsWith('draft:'))).toBeFalse();
            });
    for (const vector of layouts)
        test(vector.id, async () => {
            const zip = new JSZip();
            for (const [path, text] of Object.entries(vector.entries))
                zip.file(path, encoder.encode(text as string), { dir: path.endsWith('/'), createFolders: false });
            const report = await validateDocument(await zip.generateAsync({ type: 'arraybuffer' }));
            expect(report.format === 'valid').toBe(vector.valid);
            if (vector.valid) {
                expect(report.documentDigest).toBeNull();
                expect(report.signatures.state).toBe('unsigned');
                expect(report.recommendations.map(r => r.id)).toContain('manifest');
            }
            else
                expect(report.checks[0]!.level).toBe('error');
        });
});
describe('Normative mutations stay visible in the web report', () => {
    for (const mutation of mutations.cases)
        test(mutation.id, async () => {
            const { files, policy } = applyMutation(positive.find((c: any) => c.id === mutation.base), mutation, registry);
            const report = await validateDocument(await pack(files), { ...trust, keys: policy.keys });
            if (mutation.expected.error) {
                expect(report.format).toBe('invalid');
                return;
            }
            if (mutation.expected.content === 'file-modified')
                expect(report.format).toBe('invalid');
            for (const [kind, key] of [['document', 'document'], ['form', 'forms'], ['revision', 'revisions'], ['seal', 'seals']])
                if (mutation.expected[key])
                    expect(report.signatures.results.filter(r => r.kind === kind).map(r => r.status)).toEqual(mutation.expected[key]);
        });
});
describe('Validity, trust, and optional features remain separate', () => {
    test('minimal HTML is valid and optional recommendations never become errors', async () => {
        const report = await validateDocument(await pack({ 'index.html': encoder.encode('<p>Hello</p>') }));
        expect(report.verdict).toBe('valid');
        expect(report.documentDigest).toBeNull();
        expect(report.signatures.state).toBe('unsigned');
        expect(report.checks.every(c => c.level !== 'error')).toBeTrue();
        for (const id of ['manifest', 'original-signature', 'seal', 'html-shell'])
            expect(report.recommendations.map(r => r.id)).toContain(id);
    });
    test('an unreadable ZIP or invalid present manifest never claims signatures are absent', async () => {
        const bad = await validateDocument(new ArrayBuffer(0));
        expect(bad.format).toBe('invalid');
        expect(bad.signatures.state).toBe('not-checked');
        for (const text of ['{}', '{"manifestVersion":"2.0"}', '{"manifestVersion":"0.1","manifestVersion":"0.1"}']) {
            const report = await validateDocument(await pack({ 'index.html': encoder.encode('<p>Doc</p>'), 'manifest.json': encoder.encode(text) }));
            expect(report.format).toBe('invalid');
            expect(report.needsKeys).toBeFalse();
            expect(report.signatures.state).toBe('not-checked');
        }
    });
    test('missing and untrusted public keys produce incomplete verification, not a cryptographic failure', async () => {
        const files = decodeFiles(positive.find((c: any) => c.id === 'sealed').files);
        const missing = await validateDocument(await pack(files));
        expect(missing.format).toBe('valid');
        expect(missing.verdict).toBe('unverified');
        expect(missing.signatures.state).toBe('unverified');
        const untrusted = await validateDocument(await pack(files), { ...trust, keys: registry.keys.map((k: any) => ({ ...k, trusted: false })) });
        expect(untrusted.verdict).toBe('unverified');
        expect(untrusted.signatures.results.some(r => r.label === 'Original binding not verified')).toBeTrue();
    });
    test('malformed signature payloads are invalid even when no public key is available', async () => {
        const mutation = mutations.cases.find((c: any) => c.id === 'unknown-proof-mode');
        const { files } = applyMutation(positive.find((c: any) => c.id === mutation.base), mutation, registry);
        const report = await validateDocument(await pack(files));
        expect(report.format).toBe('invalid');
        expect(report.signatures.state).toBe('invalid');
    });
    test('failed checks do not retain an authenticated-looking signer label', async () => {
        const mutation = mutations.cases.find((c: any) => c.id === 'modified-original');
        const { files } = applyMutation(positive.find((c: any) => c.id === mutation.base), mutation, registry);
        const report = await validateDocument(await pack(files), trust);
        expect(report.signatures.results.filter(r => r.outcome === 'failed').every(r => r.signer === undefined)).toBeTrue();
    });
    test('optional HTML diagnostics are parsed as inert data including template contents', async () => {
        const html = '<!doctype html><html><head><meta charset="utf-8"><title>Document</title></head><body><template><form id="unsafe id"></form><wdoc-qr></wdoc-qr></template><form id="duplicate"></form><form id="duplicate"></form><script>throw new Error("never executed")</script></body></html>';
        const report = await validateDocument(await pack({ 'index.html': encoder.encode(html) }));
        expect(report.format).toBe('valid');
        expect(report.recommendations.map(r => r.id)).not.toContain('html-shell');
        expect(report.recommendations.map(r => r.id)).toContain('form-ids');
        expect(report.recommendations.map(r => r.id)).toContain('unknown-elements');
    });
    test('invalid text and ignored drafts are reported at their own scopes', async () => {
        const report = await validateDocument(await pack({ 'index.html': encoder.encode('<p>Doc</p>'), 'style.css': new Uint8Array([0xc3, 0x28]), 'wdoc-form/bad.json': encoder.encode('[]') }));
        expect(report.format).toBe('invalid');
        expect(report.checks.some(c => c.id === 'utf8:style.css')).toBeTrue();
        expect(report.recommendations.some(c => c.id === 'draft-json:wdoc-form/bad.json')).toBeTrue();
    });
    test('unsigned submissions and old revisions still require their declared files', async () => {
        const files = decodeFiles(positive.find((c: any) => c.id === 'revised').files);
        const manifest = parseJson(new TextDecoder().decode(files['manifest.json']!)) as Manifest;
        manifest.signatures.document = [];
        manifest.signatures.forms = [];
        manifest.runtime.revisions[0]!.signatures = [];
        delete files[manifest.runtime.submissions['approval']![0]!.answersFile];
        delete files[Object.values(manifest.runtime.revisions[0]!.files)[0]!];
        files['manifest.json'] = encoder.encode(jcs(manifest));
        const report = await validateDocument(await pack(files));
        expect(report.format).toBe('invalid');
        expect(report.checks.some(c => c.title === 'A submission file is missing')).toBeTrue();
        expect(report.checks.some(c => c.title === 'An original file is missing')).toBeTrue();
    });
    test('seal-like files in a base document remain unverified without a manifest', async () => {
        const report = await validateDocument(await pack({ 'index.html': encoder.encode('<p>Doc</p>'), 'seals/proof.jws': encoder.encode('opaque') }));
        expect(report.format).toBe('valid');
        expect(report.signatures.state).toBe('unverified');
        expect(report.needsKeys).toBeFalse();
        expect(report.recommendations.map(c => c.id)).toContain('orphan-proofs');
    });
    test('draft inventory changes remain optional and do not invalidate the original', async () => {
        const files = decodeFiles(positive.find((c: any) => c.id === 'editable-draft').files);
        files['wdoc-form/approval.json'] = encoder.encode('{"fullName":"Changed"}');
        const report = await validateDocument(await pack(files));
        expect(report.format).toBe('valid');
        expect(report.recommendations.some(c => c.id.startsWith('draft:'))).toBeTrue();
    });
    test('submission references, JSON, and attachment restrictions are checked without relying on signatures', async () => {
        const files = decodeFiles(positive.find((c: any) => c.id === 'form-signed').files), manifest = parseJson(new TextDecoder().decode(files['manifest.json']!)) as Manifest;
        manifest.signatures.document = [];
        manifest.signatures.forms = [];
        const submission = manifest.runtime.submissions['approval']![0]!;
        submission.documentDigest = 'A'.repeat(43);
        files[submission.answersFile] = encoder.encode('not JSON');
        const attachment = `submissions/${submission.submissionId}/attachments/active.svg`;
        submission.attachments.push(attachment);
        files[attachment] = encoder.encode('<svg/>');
        files['manifest.json'] = encoder.encode(jcs(manifest));
        const report = await validateDocument(await pack(files));
        expect(report.format).toBe('invalid');
        for (const title of ['Submission references an absent scope', 'Submission answers are not valid JSON', 'Unsupported submission attachment'])
            expect(report.checks.map(c => c.title)).toContain(title);
    });
    test('unsupported seal paths, nonces, and executable files are explained precisely', async () => {
        const files = decodeFiles(positive.find((c: any) => c.id === 'sealed').files);
        files['seals/other.txt'] = encoder.encode('extra');
        files['seals/bad.nonce'] = encoder.encode('not a nonce');
        files['seals/unsafe id.jws'] = encoder.encode('bad');
        files['wdoc-form/script.js'] = encoder.encode('unused');
        const report = await validateDocument(await pack(files), trust);
        expect(report.format).toBe('invalid');
        for (const title of ['Invalid seal path', 'Seal pair is incomplete', 'Invalid seal file', 'Unsupported signed archive file'])
            expect(report.checks.map(c => c.title)).toContain(title);
    });
    test('progress is local and validation never mutates supplied bytes', async () => {
        const file = await pack(decodeFiles(positive.find((c: any) => c.id === 'document-signed').files)), before = Buffer.from(file.slice(0)), phases: string[] = [];
        const report = await validateDocument(file, trust, phase => phases.push(phase));
        expect(report.verdict).toBe('valid');
        expect(Buffer.from(file)).toEqual(before);
        expect(phases).toHaveLength(3);
        expect(emptyTrust('offline').detail).toBe('offline');
    });
    test('noncanonical but valid signed JSON is a producer recommendation, not a reader rejection', async () => {
        const files: Files = { 'index.html': encoder.encode('<p>Document</p>') };
        const manifest: Manifest = { manifestVersion: '0.1', meta: { docId: 'doc', appVersion: 'test', createdAt: '2026-10-17T00:00:00.000Z', contentUpdatedAt: '2026-10-17T00:00:00.000Z' }, content: { hashAlgorithm: 'SHA-256', files: await inventory(files) }, runtime: { submissions: {}, revisions: [] }, signatures: { document: [], forms: [] } };
        const pair = await generateKeyPair('ES256', { extractable: true }), nonce = newNonce(), kid = 'https://sig.wdoc.info/info/noncanonical';
        const payload = { type: 'wdoc-document-signature', proofMode: 'digest-only', documentCommitment: await commitment('document', await documentDigest(manifest), nonce), signer: { userId: 'alice', displayName: 'Alice' }, signedAt: '2026-10-17T00:00:00.000Z', evidence: { scope: 'commitment-only', method: 'authenticated-session', consent: 'wdoc-sign-v1' } };
        manifest.signatures.document.push({ signatureId: 'sig', nonce, jws: await new CompactSign(encoder.encode(JSON.stringify(payload, null, 2))).setProtectedHeader({ alg: 'ES256', typ: 'wdoc-document+jws', kid }).sign(pair.privateKey) });
        files['manifest.json'] = encoder.encode(jcs(manifest));
        const report = await validateDocument(await pack(files), { ...trust, keys: [{ kid, jwk: await exportJWK(pair.publicKey), status: 'active', trusted: true, authority: 'platform', owner: 'Test' }] });
        expect(report.verdict).toBe('valid');
        expect(report.recommendations.some(c => c.id === 'jcs:document:sig')).toBeTrue();
    });
});
