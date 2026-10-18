import { test, expect, type Page } from '@playwright/test';
import JSZip from 'jszip';
import { readFile } from 'node:fs/promises';
import { executablePath } from 'puppeteer';

test.use({ launchOptions: { executablePath: executablePath() }, viewport: { width: 1280, height: 900 } });

let original: number[];
test.beforeAll(async () => {
  const zip = new JSZip();
  zip.file('index.html', '<!doctype html><html><head><title>Local report</title></head><body><p>Original local document</p><img src="images/pixel.png"><p><a href="wdoc-attachment/guide.pdf">Guide</a></p></body></html>');
  zip.file('images/pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAqkAAAAASUVORK5CYII=', 'base64'));
  zip.file('wdoc-attachment/guide.pdf', 'original PDF bytes');
  zip.file('wdoc-form/answers.json', '{"name":"Alice"}');
  original = Array.from(await zip.generateAsync({ type: 'uint8array' }));
});

/** Real browser directory/file handles exercise streams and IndexedDB; only native pickers are replaced. */
async function setupFolder(page: Page) {
  await page.addInitScript(async ({ bytes }) => {
    const state = window as any;
    state.__directoryPicks = 0; state.__savePicks = 0;
    state.__localFsReady = (async () => {
      const root = await navigator.storage.getDirectory();
      const folder = await root.getDirectoryHandle('Local documents', { create: true });
      for (const name of ['Report 2.wdoc', 'Report 10.WDOC', 'notes.txt', 'other.zip']) {
        try { await folder.getFileHandle(name); }
        catch {
          const file = await folder.getFileHandle(name, { create: true });
          const stream = await file.createWritable(); await stream.write(new Uint8Array(bytes)); await stream.close();
        }
      }
      await folder.getDirectoryHandle('subfolder.wdoc', { create: true });
      return folder;
    })();
    state.showDirectoryPicker = async (options: unknown) => { state.__directoryPicks++; state.__directoryOptions = options; return state.__localFsReady; };
    state.showSaveFilePicker = async (options: any) => {
      state.__savePicks++;
      return (await state.__localFsReady).getFileHandle(state.__saveName || options.suggestedName, { create: true });
    };
  }, { bytes: original });
  await page.goto('/');
}
async function chooseFolder(page: Page) {
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder', exact: true }).click();
  await expect(page.getByRole('list', { name: 'wdoc files in this folder' }).getByRole('button')).toHaveText(['Report 2.wdoc', 'Report 10.WDOC']);
}
async function openReport(page: Page) {
  await page.getByRole('button', { name: 'Report 2.wdoc', exact: true }).click();
  await expect(page.locator('app-viewer').getByText('Original local document')).toBeVisible();
  await page.getByRole('button', { name: 'Update document', exact: true }).click();
}
async function readLocal(page: Page, name: string) {
  const bytes = await page.evaluate(async name => Array.from(new Uint8Array(await (await (await (window as any).__localFsReady).getFileHandle(name)).getFile().then((file: File) => file.arrayBuffer()))), name);
  return JSZip.loadAsync(new Uint8Array(bytes));
}

test('lists local documents and overwrites the linked file on Save and Cmd/Ctrl+S without another picker', async ({ page }) => {
  await setupFolder(page); await chooseFolder(page); await openReport(page);
  const downloads: string[] = []; page.on('download', download => downloads.push(download.suggestedFilename()));
  const paragraph = page.locator('app-document-editor [contenteditable=true] p').first();
  await paragraph.fill('First local edit');
  await page.getByRole('textbox', { name: 'Document title', exact: true }).fill('A different title');
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to Report 2.wdoc' })).toBeVisible();
  const first = await readLocal(page, 'Report 2.wdoc');
  const firstHtml = await first.file('index.html')!.async('text');
  expect(firstHtml).toContain('First local edit'); expect(firstHtml).toContain('src="images/pixel.png"');
  expect(firstHtml).toContain('href="wdoc-attachment/guide.pdf"'); expect(firstHtml).not.toContain('blob:');
  expect(await first.file('wdoc-attachment/guide.pdf')!.async('text')).toBe('original PDF bytes');
  expect(await first.file('wdoc-form/answers.json')!.async('text')).toContain('Alice');
  expect(first.file('images/pixel.png')).not.toBeNull();
  const docId = JSON.parse(await first.file('manifest.json')!.async('text')).meta.docId;
  await paragraph.fill('Second local edit');
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeEnabled();
  await paragraph.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: /^(Save document|Saving…)$/ })).toBeHidden();
  const second = await readLocal(page, 'Report 2.wdoc');
  expect(await second.file('index.html')!.async('text')).toContain('Second local edit');
  expect(JSON.parse(await second.file('manifest.json')!.async('text')).meta.docId).toBe(docId);
  expect(await (await readLocal(page, 'Report 10.WDOC')).file('index.html')!.async('text')).toContain('Original local document');
  expect(await page.evaluate(() => [(window as any).__directoryPicks, (window as any).__savePicks, (window as any).__directoryOptions.mode])).toEqual([1, 0, 'readwrite']);
  expect(downloads).toEqual([]);
  await expect(page.getByRole('button', { name: 'Report 2.wdoc', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: test.info().outputPath('local-folder.png'), fullPage: true });
});

test('selects a destination once for a new document, then saves directly to it', async ({ page }) => {
  await setupFolder(page); await chooseFolder(page);
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const editor = page.locator('app-document-editor [contenteditable=true]').first();
  await editor.fill('A new local document');
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to new-document.wdoc' })).toBeVisible();
  await editor.fill('Updated new local document');
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeEnabled();
  await editor.press('ControlOrMeta+s');
  await expect(page.getByRole('button', { name: /^(Save document|Saving…)$/ })).toBeHidden();
  expect(await page.evaluate(() => (window as any).__savePicks)).toBe(1);
  expect(await (await readLocal(page, 'new-document.wdoc')).file('index.html')!.async('text')).toContain('Updated new local document');
  await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'new-document.wdoc', exact: true })).toBeVisible();
});

test('keeps edits after an external change and supports Save as without overwriting the other version', async ({ page }) => {
  await setupFolder(page); await chooseFolder(page); await openReport(page);
  await page.locator('app-document-editor [contenteditable=true]').first().fill('Keep my edits');
  await page.evaluate(async () => {
    const handle = await (await (window as any).__localFsReady).getFileHandle('Report 2.wdoc');
    const writable = await handle.createWritable(); await writable.write('An externally changed file'); await writable.close();
  });
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('changed outside wdoc');
  await expect(page.getByRole('button', { name: 'Save document', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).__saveName = 'copy.wdoc'; });
  await page.getByRole('button', { name: 'Save as…', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved to copy.wdoc' })).toBeVisible();
  expect(await (await readLocal(page, 'copy.wdoc')).file('index.html')!.async('text')).toContain('Keep my edits');
  expect(await page.evaluate(async () => (await (await (await (window as any).__localFsReady).getFileHandle('Report 2.wdoc')).getFile()).text())).toBe('An externally changed file');
});

test('restores a directory handle after reload and disconnects it without modifying its files', async ({ page }) => {
  await setupFolder(page); await chooseFolder(page); await page.reload();
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report 2.wdoc', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__directoryPicks)).toBe(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeVisible();
  expect(await (await readLocal(page, 'Report 2.wdoc')).file('index.html')!.async('text')).toContain('Original local document');
});

test('retains open and download workflows when File System Access is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined });
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Local folder', exact: true }).click();
  await expect(page.getByText('Direct folder access is unavailable in this browser.', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  await page.locator('app-document-editor [contenteditable=true]').first().fill('Downloaded document');
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  const zip = await JSZip.loadAsync(await readFile((await (await downloaded).path())!));
  expect(await zip.file('index.html')!.async('text')).toContain('Downloaded document');
  await expect(page.getByRole('button', { name: 'Save as…', exact: true })).toHaveCount(0);
});
