import { test, expect, type Page } from '@playwright/test';
import { executablePath } from 'puppeteer';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GitEngine, type Snapshot } from '../src/app/history/git-engine';

test.use({ launchOptions: { executablePath: executablePath() }, viewport: { width: 1440, height: 1100 } });
function snapshot(body: string, id: string): Snapshot {
  const html = new TextEncoder().encode(`<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Project proposal</title></head><body>${body}</body></html>`);
  const manifest = { manifestVersion: '0.1', meta: { docId: id, appVersion: '0.1', createdAt: '2026-01-01T00:00:00Z', contentUpdatedAt: '2026-01-01T00:00:00Z', docTitle: 'Project proposal' }, content: { hashAlgorithm: 'SHA-256', files: { 'index.html': createHash('sha256').update(html).digest('base64url') } }, runtime: { submissions: {}, revisions: [] }, signatures: { document: [], forms: [] } };
  return { 'index.html': html, 'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)) };
}
async function zip(files: Snapshot): Promise<Buffer> { const archive = new JSZip(); for (const [path, bytes] of Object.entries(files)) archive.file(path, bytes, { createFolders: false }); return archive.generateAsync({ type: 'nodebuffer' }); }
async function files(buffer: Buffer): Promise<Snapshot> { const archive = await JSZip.loadAsync(buffer), result: Snapshot = {}; for (const entry of Object.values(archive.files)) if (!entry.dir) result[entry.name] = await entry.async('uint8array'); return result; }
async function open(page: Page, buffer: Buffer) {
  await page.goto('/');
  await page.locator('app-navbar input[type=file]').setInputFiles({ name: 'proposal.wdoc', mimeType: 'application/zip', buffer });
  await expect(page.locator('app-viewer')).toContainText('Project');
  await page.getByRole('button', { name: 'Version history', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Document versions' }).getByRole('button', { name: 'View version: Initial document', exact: true })).toBeVisible();
}

async function setupLinked(page: Page, buffer: Buffer): Promise<void> {
  await page.addInitScript(async ({ bytes }) => {
    const state = window as any;
    state.__folder = (async () => {
      const root = await navigator.storage.getDirectory(), folder = await root.getDirectoryHandle('history-e2e', { create: true });
      const handle = await folder.getFileHandle('Proposal.wdoc', { create: true });
      if (!(await handle.getFile()).size) { const stream = await handle.createWritable(); await stream.write(new Uint8Array(bytes)); await stream.close(); }
      return folder;
    })();
    state.showDirectoryPicker = async () => state.__folder;
  }, { bytes: Array.from(buffer) });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click(); await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await page.getByRole('button', { name: 'Proposal.wdoc', exact: true }).click();
}

test('visually merges independent changes, previews the result and exports a real merge with imported ancestry', async ({ page }) => {
  const id = 'history-e2e-merge', first = new GitEngine(), root = await first.open(snapshot('<h1>Project launch</h1><p>Budget: 100</p><p>Delivery: June</p>', id), 'original');
  const second = new GitEngine(); await second.open(root.files, 'incoming');
  const ours = await first.publish(snapshot('<h1>Project launch</h1><p>Budget: 120</p><p>Delivery: June</p>', id));
  const incoming = await second.publish(snapshot('<h1>Project launch</h1><p>Budget: 100</p><p>Delivery: July</p>', id));
  await open(page, await zip(ours.files));
  await page.locator('app-history-panel input[type=file]').setInputFiles({ name: 'incoming.wdoc', mimeType: 'application/zip', buffer: await zip(incoming.files) });
  await expect(page.getByRole('region', { name: 'Visual version merge' })).toBeVisible();
  await expect(page.getByText('Independent changes were merged automatically.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Preview result', exact: true }).click();
  await expect(page.frameLocator('iframe[title="Merged result"]').locator('body')).toContainText('Budget: 120');
  await expect(page.frameLocator('iframe[title="Merged result"]').locator('body')).toContainText('Delivery: July');
  await expect.poll(() => page.frameLocator('iframe[title="Your version"]').locator('html').evaluate(node => node.clientWidth)).toBeGreaterThan(300);
  await page.locator('app-history-panel .merge').screenshot({ path: '/private/tmp/wdoc-version-merge.png' });
  await page.getByRole('button', { name: 'Use merged draft', exact: true }).click();
  await expect(page.locator('app-document-editor')).toContainText('Delivery: July');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  const result = await files(await readFile((await (await downloaded).path())!));
  const reopened = await new GitEngine().open(result, 'verify');
  expect(reopened.entries.find(entry => entry.oid === reopened.main)!.parents).toContain(incoming.main);
  expect(new TextDecoder().decode(result['index.html'])).toContain('Budget: 120');
  expect(JSON.parse(new TextDecoder().decode(result['manifest.json'])).signatures.document).toEqual([]);
  expect(reopened.entries.filter(entry => entry.autosave).length).toBeGreaterThan(1);
});

test('requires visual conflict choices for unrelated versions and restores an old version as a new draft', async ({ page }) => {
  const engine = new GitEngine(), initial = await engine.open(snapshot('<h1>Project launch</h1><p>Original proposal</p>', 'history-ours'), 'session');
  const saved = await engine.publish(snapshot('<h1>Project launch</h1><p>Current proposal</p>', 'history-ours'));
  await open(page, await zip(saved.files));
  const incoming = snapshot('<h1>Project launch</h1><p>Alternative proposal</p>', 'history-unrelated');
  await page.locator('app-history-panel input[type=file]').setInputFiles({ name: 'alternative.wdoc', mimeType: 'application/zip', buffer: await zip(incoming) });
  await expect(page.getByText('No common ancestor was found.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use merged draft', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Keep incoming', exact: true }).click();
  await page.getByRole('button', { name: 'Use merged draft', exact: true }).click();
  await expect(page.locator('app-document-editor')).toContainText('Alternative proposal');
  const initialRow = page.getByRole('list', { name: 'Document versions' }).locator('li').filter({ has: page.getByRole('button', { name: 'View version: Initial document', exact: true }) });
  await initialRow.getByRole('button', { name: 'Restore as draft', exact: true }).click();
  await expect(page.locator('app-document-editor')).toContainText('Original proposal');
  expect(initial.main).toBeTruthy();
});

test('autosaves to the linked archive after 30 seconds, keeps main unchanged and recovers the draft after reload', async ({ page }) => {
  const buffer = await zip(snapshot('<h1>Project launch</h1><p>Published text</p>', 'history-local-recovery'));
  await page.clock.install();
  await setupLinked(page, buffer);
  await page.getByRole('button', { name: 'Update document', exact: true }).click();
  await page.locator('app-document-editor [contenteditable=true]').first().fill('Recovered working draft');
  // Accelerate browser timers, retaining actual worker, IndexedDB, ZIP and file writes.
  await page.clock.fastForward(31_000);
  await expect(page.getByRole('status').filter({ hasText: 'Autosaved · unpublished draft' })).toBeVisible();
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await (await (window as any).__folder).getFileHandle('Proposal.wdoc')).getFile().then((file: File) => file.arrayBuffer()))));
  const archived = await files(Buffer.from(bytes));
  expect(new TextDecoder().decode(archived['index.html'])).toContain('Published text');
  expect(Object.keys(archived).some(path => path.startsWith('.git/objects/'))).toBeTruthy();
  await page.reload();
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click();
  await page.getByRole('button', { name: 'Proposal.wdoc', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Recover draft', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Recover draft', exact: true }).click();
  await expect(page.locator('app-document-editor')).toContainText('Recovered working draft');
});


test('merges a changed local file and saves against its imported baseline without another picker', async ({ page }) => {
  const buffer = await zip(snapshot('<h1>Project launch</h1><p>Published text</p>', 'history-external-merge'));
  await setupLinked(page, buffer);
  await page.getByRole('button', { name: 'Update document', exact: true }).click();
  await page.locator('app-document-editor [contenteditable=true]').first().fill('My working version');
  const external = await zip(snapshot('<h1>Project launch</h1><p>External version</p>', 'history-external-merge'));
  await page.evaluate(async bytes => {
    const handle = await (await (window as any).__folder).getFileHandle('Proposal.wdoc'), writable = await handle.createWritable();
    await writable.write(new Uint8Array(bytes)); await writable.close();
  }, Array.from(external));
  await page.locator('app-topbar').getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'outside wdoc' })).toBeVisible();
  await page.getByRole('button', { name: 'Merge changed local file', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Visual version merge' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep yours', exact: true }).click();
  await page.getByRole('button', { name: 'Use merged draft', exact: true }).click();
  await page.locator('app-topbar').getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Proposal.wdoc' })).toBeVisible();
  const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await (await (await (window as any).__folder).getFileHandle('Proposal.wdoc')).getFile().then((file: File) => file.arrayBuffer()))));
  const saved = await files(Buffer.from(bytes));
  expect(new TextDecoder().decode(saved['index.html'])).toContain('My working version');
  const reopened = await new GitEngine().open(saved, 'verify');
  expect(reopened.entries.find(entry => entry.oid === reopened.main)?.message).toBe('Merge document version');
});
