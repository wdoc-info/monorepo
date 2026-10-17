import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import JSZip from 'jszip';
import { executablePath } from 'puppeteer';
import { encoder, inventory, jcs } from '../src/app/signatures/core';

test.use({ launchOptions: { executablePath: executablePath() } });
let server: ChildProcess;
type Session = { token: string; user: { id: string; email: string } };
let authority: { url: string; session: Session; peerSession: Session };
test.beforeAll(async () => {
  server = spawn('bun', ['src/tests/signature-server.ts'], { cwd: path.resolve(__dirname, '../../backend.wdoc.info'), stdio: ['ignore', 'pipe', 'pipe'] });
  authority = await new Promise((resolve, reject) => {
    let text = ''; server.stdout!.on('data', chunk => { text += chunk.toString(); if (text.includes('\n')) { try { resolve(JSON.parse(text.trim())); } catch (e) { reject(e); } } });
    server.on('error', reject); server.on('exit', code => { if (code) reject(new Error(`Signing test server exited ${code}`)); });
  });
});
test.afterAll(() => server?.kill());

test('signs originals, freezes reviewed answers and seals a portable archive with the real API', async ({ page, browser }) => {
  await page.addInitScript(session => localStorage.setItem('wdoc-auth-session', JSON.stringify(session)), authority.session);
  const signingRequests: Array<{ path: string; body: any }> = [];
  await page.route('http://localhost:3000/**', async route => {
    if (route.request().method() === 'POST') signingRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    const target = new URL(new URL(route.request().url()).pathname, authority.url).toString();
    const response = await route.fetch({ url: target }); await route.fulfill({ response });
  });
  const html = '<!doctype html><html><head><title>Signature test</title></head><body><wdoc-page><wdoc-content><form id="contract"><label>Name <input name="fullName" required></label></form></wdoc-content></wdoc-page></body></html>';
  const now = new Date().toISOString(); const docId = crypto.randomUUID();
  const manifest = { manifestVersion: '1.0', meta: { docId, appVersion: 'test', createdAt: now, contentUpdatedAt: now }, content: { hashAlgorithm: 'SHA-256', files: await inventory({ 'index.html': encoder.encode(html) }) }, runtime: { submissions: {}, revisions: [], forms: {} }, signatures: { document: [], forms: [] } };
  const zip = new JSZip(); zip.file('index.html', html); zip.file('manifest.json', jcs(manifest));
  await page.goto('/');
  await page.locator('app-navbar input[type=file]').setInputFiles({ name: 'contract.wdoc', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  const panel = page.locator('app-signature-panel');
  await panel.getByRole('button', { name: 'Signatures · Unsigned', exact: true }).click();
  await panel.getByRole('button', { name: 'Sign original document', exact: true }).click();
  await expect(panel.getByText('Verified signature · trusted key', { exact: true })).toHaveCount(1);
  await page.locator('app-viewer input[name=fullName]').fill('Alice exact answers');
  await panel.getByRole('button', { name: 'Review current answers for a new signed snapshot' }).click();
  await expect(panel.getByLabel('Exact answer snapshot')).toContainText('Alice exact answers');
  await expect(panel.getByRole('button', { name: 'Confirm and sign snapshot' })).toBeDisabled();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Confirm and sign snapshot' }).click();
  await expect(panel.getByText('Verified signature · trusted key', { exact: true })).toHaveCount(2);
  await panel.getByRole('button', { name: 'Seal complete archive', exact: true }).click();
  await expect(panel.getByText('Verified signature · trusted key', { exact: true })).toHaveCount(3);
  await expect(panel.getByRole('alert')).toHaveCount(0);
  const download = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download archive', exact: true }).click();
  const stream = await (await download).createReadStream(); const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  const saved = await JSZip.loadAsync(Buffer.concat(chunks)); const signed = JSON.parse(await saved.file('manifest.json')!.async('text'));
  expect(signed.meta).toEqual(manifest.meta); expect(signed.content).toEqual(manifest.content);
  expect(signed.signatures.document).toHaveLength(1); expect(signed.signatures.forms).toHaveLength(1);
  const submission = signed.runtime.submissions.contract[0]; expect(await saved.file(submission.answersFile)!.async('text')).toContain('Alice exact answers');
  expect(Object.keys(saved.files).filter(p => p.startsWith('seals/') && p.endsWith('.jws'))).toHaveLength(1);
  // Co-signing works by opening the exchanged archive in another browser/account, without a document server.
  const peer = await browser.newContext();
  try {
    await peer.addInitScript(session => localStorage.setItem('wdoc-auth-session', JSON.stringify(session)), authority.peerSession);
    await peer.route('http://localhost:3000/**', async route => { if (route.request().method() === 'POST') signingRequests.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() }); const response = await route.fetch({ url: new URL(new URL(route.request().url()).pathname, authority.url).toString() }); await route.fulfill({ response }); });
    const exchanged = new JSZip();
    for (const entry of Object.values(saved.files)) if (!entry.dir) exchanged.file(`Shared report/${entry.name}`, await entry.async('uint8array'), { createFolders: false });
    const otherPage = await peer.newPage(); await otherPage.goto('http://localhost:4200/');
    await otherPage.locator('app-navbar input[type=file]').setInputFiles({ name: 'exchanged.wdoc', mimeType: 'application/zip', buffer: await exchanged.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) });
    const otherPanel = otherPage.locator('app-signature-panel');
    await otherPanel.getByRole('button', { name: /Signatures ·/ }).click();
    await otherPanel.getByRole('button', { name: 'Co-sign this snapshot', exact: true }).click();
    await expect(otherPanel.getByLabel('Exact answer snapshot')).toContainText('Alice exact answers');
    await otherPanel.getByRole('checkbox').check(); await otherPanel.getByRole('button', { name: 'Confirm and sign snapshot' }).click();
    await expect(otherPanel.getByText('Verified signature · trusted key', { exact: true })).toHaveCount(3);
    await expect(otherPanel.getByText('Archive changed since this seal', { exact: true })).toHaveCount(1);
  } finally { await peer.close(); }

  await page.getByRole('button', { name: 'Update document', exact: true }).click();
  await page.locator('app-document-editor [contenteditable=true]').fill('Revised original content');
  const revisedDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save as new signed content revision', exact: true }).click();
  const revisionStream = await (await revisedDownload).createReadStream(); const revisionChunks: Buffer[] = [];
  for await (const chunk of revisionStream!) revisionChunks.push(chunk);
  const revisedZip = await JSZip.loadAsync(Buffer.concat(revisionChunks));
  const revisedManifest = JSON.parse(await revisedZip.file('manifest.json')!.async('text'));
  expect(revisedManifest.meta.docId).toBe(docId); expect(revisedManifest.runtime.revisions).toHaveLength(1);
  expect(revisedManifest.signatures.document).toHaveLength(1); expect(revisedManifest.signatures.forms).toHaveLength(1);
  expect(await revisedZip.file('index.html')!.async('text')).toContain('Revised original content');
  await panel.getByRole('button', { name: /Signatures ·/ }).click();
  await expect(panel.getByText('Verified signature · trusted key', { exact: true })).toHaveCount(3);
  await expect(panel.getByText('Archive changed since this seal', { exact: true })).toHaveCount(1);
  expect(signingRequests.length).toBe(5);
  for (const request of signingRequests) {
    expect(request.path).toMatch(/^\/signatures\/(document|form|seal)$/);
    for (const field of ['files', 'answers', 'attachments', 'manifest', 'docId', 'formId', 'nonce', 'title']) expect(request.body).not.toHaveProperty(field);
    for (const value of ['Alice exact answers', 'Revised original content', 'Signature test', 'index.html', docId]) expect(JSON.stringify(request.body)).not.toContain(value);
  }


});

for (const prefix of ['', 'Report/']) {
  test(`opens and signs a ZIP containing only ${prefix}index.html`, async ({ page }) => {
    await page.addInitScript(session => localStorage.setItem('wdoc-auth-session', JSON.stringify(session)), authority.session);
    const posts: any[] = [];
    await page.route('http://localhost:3000/**', async route => {
      if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
      const response = await route.fetch({ url: new URL(new URL(route.request().url()).pathname, authority.url).toString() });
      await route.fulfill({ response });
    });
    const zip = new JSZip(); zip.file(`${prefix}index.html`, '<!doctype html><html><body><p>Local unsigned document</p></body></html>', {createFolders:false});
    await page.goto('/');
    await page.locator('app-navbar input[type=file]').setInputFiles({ name:'minimal.wdoc', mimeType:'application/zip', buffer:await zip.generateAsync({type:'nodebuffer'}) });
    await expect(page.locator('app-viewer').getByText('Local unsigned document', {exact:true})).toBeVisible();
    const panel = page.locator('app-signature-panel');
    await panel.getByRole('button', {name:'Signatures · Unsigned',exact:true}).click();
    expect(posts).toHaveLength(0);
    await panel.getByRole('button', {name:'Sign original document',exact:true}).click();
    await expect(panel.getByText('Verified signature · trusted key',{exact:true})).toHaveCount(1);
    expect(posts).toHaveLength(1);
    expect(Object.keys(posts[0]).sort()).toEqual(['consent','documentCommitment','requestId']);
    expect(JSON.stringify(posts[0])).not.toContain('Local unsigned document');
    const download = page.waitForEvent('download'); await panel.getByRole('button',{name:'Download archive',exact:true}).click();
    const stream = await (await download).createReadStream(), chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk);
    const result = await JSZip.loadAsync(Buffer.concat(chunks));
    expect(await result.file('index.html')!.async('text')).toContain('Local unsigned document');
    expect(JSON.parse(await result.file('manifest.json')!.async('text')).signatures.document).toHaveLength(1);
    expect(result.file('Report/index.html')).toBeNull();
  });
}
