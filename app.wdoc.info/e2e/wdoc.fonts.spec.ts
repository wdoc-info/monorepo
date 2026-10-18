import { test, expect, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import JSZip from 'jszip';
import { executablePath } from 'puppeteer';
import { encoder, inventory, jcs, sha256, type Manifest } from '../src/app/signatures/core';

test.use({ launchOptions: { executablePath: executablePath() } });
const packageRequire = createRequire(join(__dirname, '../package.json'));
const assets = join(dirname(packageRequire.resolve('playwright-core/package.json')), 'lib/vite/recorder/assets');
let font: Buffer;
test.beforeAll(async () => { font = await readFile(join(assets, (await readdir(assets)).find(name => name.endsWith('.ttf'))!)); });
const googleFont = 'https://fonts.gstatic.com/s/test/regular.ttf';
const unknownFont = 'https://fonts.example.test/regular.ttf';
const html = (url: string) => `<!doctype html><html><head><title>Font document</title><style>@font-face{font-family:DocumentFont;src:url("${url}")} body{font-family:DocumentFont,sans-serif}</style></head><body><p>External font document</p></body></html>`;
async function pack(content: string, extra: Record<string, Uint8Array | string> = {}) { const zip = new JSZip(); zip.file('index.html', content); for (const [path, bytes] of Object.entries(extra)) zip.file(path, bytes, {createFolders:false}); return zip.generateAsync({type:'nodebuffer'}); }
async function open(page: Page, bytes: Buffer) { await page.locator('app-navbar input[type=file]').setInputFiles({name:'font.wdoc',mimeType:'application/zip',buffer:bytes}); await expect(page.locator('app-viewer').getByText('External font document')).toBeVisible(); }
async function pinned(url: string, copies = false) {
  const text = html(url), hash = await sha256(font), now = new Date().toISOString();
  const manifest: Manifest = { manifestVersion:'0.1',meta:{docId:crypto.randomUUID(),appVersion:'test',createdAt:now,contentUpdatedAt:now},content:{hashAlgorithm:'SHA-256',files:await inventory({'index.html':encoder.encode(text)}),externalFonts:{[url]:hash}},runtime:{submissions:{},revisions:[]},signatures:{document:[],forms:[]} };
  return pack(text, {'manifest.json':jcs(manifest),...(copies?{[`wdoc-font-cache/${hash}`]:font}:{})});
}

test('loads default provider fonts before pagination and scopes the family to the document', async ({page}) => {
  let requests = 0;
  await page.route(googleFont, route => { requests++; return route.fulfill({status:200,contentType:'font/ttf',body:font}); });
  await page.goto('/'); const applicationFamily = await page.locator('app-navbar button').first().evaluate(element => getComputedStyle(element).fontFamily);
  await open(page, await pack(html(googleFont)));
  await expect(page.getByRole('heading',{name:'Load external fonts?'})).toHaveCount(0);
  expect(requests).toBe(1);
  const family = await page.locator('app-viewer p').evaluate(element => getComputedStyle(element).fontFamily);
  expect(family).toContain('wdoc-'); expect(await page.evaluate(family => document.fonts.check(`16px ${family}`), family)).toBe(true);
  expect(await page.locator('app-navbar button').first().evaluate(element => getComputedStyle(element).fontFamily)).toBe(applicationFamily);
});

test('remembers explicit origin trust, then lets a persistent block override it', async ({page}) => {
  let requests = 0; await page.route(unknownFont, route => { requests++; return route.fulfill({status:200,contentType:'font/ttf',body:font}); });
  await page.goto('/');
  const bytes = await pack(html(unknownFont));
  await page.locator('app-navbar input[type=file]').setInputFiles({name:'font.wdoc',mimeType:'application/zip',buffer:bytes});
  await expect(page.getByRole('heading',{name:'Load external fonts?'})).toBeVisible(); expect(requests).toBe(0);
  await page.getByLabel('Font permission for https://fonts.example.test').selectOption('always'); await page.getByRole('button',{name:'Continue',exact:true}).click();
  await expect(page.locator('app-viewer p')).toBeVisible(); expect(requests).toBe(1);
  await page.reload(); await open(page, bytes); expect(requests).toBe(2); await expect(page.getByRole('heading',{name:'Load external fonts?'})).toHaveCount(0);
  await page.getByRole('button',{name:'Font settings',exact:true}).click(); await page.getByLabel('Font policy for https://fonts.example.test').selectOption('block'); await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.reload(); await open(page, bytes); expect(requests).toBe(2); await expect(page.getByText('Loading this source was not permitted.',{exact:false})).toBeVisible();
});

test('distinguishes a changed remote font from document integrity and reads embedded copies offline', async ({page}) => {
  await page.route(googleFont, route => route.fulfill({status:200,body:Buffer.from('wOF2 incorrect font bytes')}));
  await page.goto('/'); await open(page, await pinned(googleFont));
  await expect(page.getByRole('alert').filter({hasText:'does not match its protected SHA-256'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Verification failed',exact:true})).toHaveCount(0);
  let outbound = 0; await page.unroute(googleFont); await page.route('https://**/*', route => {outbound++; return route.abort();});
  await open(page, await pinned(googleFont,true)); expect(outbound).toBe(0);
  await page.getByText('Document fonts',{exact:true}).click(); await expect(page.getByText('Font bytes match the manifest.',{exact:false})).toBeVisible();
});

test('imports provider CSS as font declarations, exports fingerprints and embedded font bytes', async ({page}) => {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=DocumentFont';
  await page.route(cssUrl, route => route.fulfill({status:200,contentType:'text/css',body:`body{background:url(https://tracker.example/pixel)} @font-face{font-family:DocumentFont;src:url("${googleFont}")}`}));
  await page.route(googleFont, route => route.fulfill({status:200,contentType:'font/ttf',body:font}));
  const unwanted: string[] = []; page.on('request', request => {if(request.url().includes('tracker.example')) unwanted.push(request.url());});
  await page.goto('/');
  await page.getByRole('button',{name:'New document',exact:true}).click(); await page.getByText('Add an external font',{exact:true}).click();
  await page.getByLabel('Font family',{exact:true}).fill('DocumentFont'); await page.getByLabel('Font URL',{exact:true}).fill(cssUrl); await page.getByRole('button',{name:'Add font',exact:true}).click();
  await expect(page.getByLabel('Document font').locator('optgroup[label="Document fonts"] option')).toHaveCount(1);
  await page.locator('app-document-editor [contenteditable=true]').first().fill('Exported font text');
  await page.getByLabel('Include fonts for offline viewing',{exact:true}).check();
  const downloaded = page.waitForEvent('download'); await page.getByRole('button',{name:'Save document',exact:true}).click();
  const download = await downloaded, archive = await JSZip.loadAsync(await readFile((await download.path())!));
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('text'));
  expect(manifest.content.externalFonts[googleFont]).toBe(await sha256(font)); expect(archive.file(`wdoc-font-cache/${await sha256(font)}`)).not.toBeNull();
  const content = await archive.file('index.html')!.async('text'); expect(content).toContain('@font-face'); expect(content).not.toContain('tracker.example'); expect(content).not.toContain('fonts.googleapis.com'); expect(unwanted).toEqual([]);
});

test('keeps an archive-local font loaded before layout and preserves it through editing and export', async ({page}) => {
  await page.goto('/'); await open(page, await pack(html('fonts/embedded.ttf'), {'fonts/embedded.ttf':font}));
  expect(await page.locator('app-viewer p').evaluate(element => getComputedStyle(element).fontFamily)).toContain('wdoc-');
  await page.getByRole('button',{name:'Update document',exact:true}).click();
  await expect(page.getByLabel('Document font').locator('optgroup[label="Document fonts"] option')).toHaveCount(1);
  await page.locator('app-document-editor [contenteditable=true]').first().fill('Edited local font content');
  const download = page.waitForEvent('download'); await page.getByRole('button',{name:'Save document',exact:true}).click();
  const archive = await JSZip.loadAsync(await readFile((await (await download).path())!));
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('text'));
  const fontPath = `wdoc-assets/fonts/${await sha256(font)}.ttf`;
  expect(manifest.content.files[fontPath]).toBe(await sha256(font)); expect(manifest.content.externalFonts).toBeUndefined();
  expect(await archive.file(fontPath)!.async('nodebuffer')).toEqual(font);
  expect(await archive.file('index.html')!.async('text')).toContain('Edited local font content');
});

test('searches Google Fonts, preserves the selection while loading, and reopens mixed families offline', async ({page}) => {
  const requestedFamilies: string[] = [];
  await page.route('https://fonts.googleapis.com/css2?*', async route => {
    const spec = new URL(route.request().url()).searchParams.get('family')!;
    requestedFamilies.push(spec);
    const family = spec.split(':')[0];
    await route.fulfill({ status: 200, contentType: 'text/css', body: `@font-face{font-family:"${family}";font-style:normal;font-weight:400;src:url("https://fonts.gstatic.com/s/${family.toLowerCase()}/regular.ttf")}` });
  });
  await page.route('https://fonts.gstatic.com/s/**', route => route.fulfill({ status: 200, contentType: 'font/ttf', body: font }));
  await page.goto('/');
  await page.getByRole('button', { name: 'New document', exact: true }).click();
  const editor = page.locator('app-document-editor [contenteditable=true]').first();
  const picker = page.getByLabel('Document font', { exact: true });
  const search = page.getByRole('searchbox', { name: 'Search Google Fonts' });
  await editor.fill('Sans and serif.');
  await editor.press('ControlOrMeta+a');
  await search.fill('inter');
  expect(requestedFamilies).toEqual([]);
  await picker.selectOption('google:Inter');
  await expect(picker).toBeEnabled();
  await expect(editor.locator('span[style*="font-family"]')).toHaveText('Sans and serif.');
  expect(requestedFamilies).toEqual(['Inter:ital,wght@0,400;0,700;1,400;1,700']);
  const sansAlias = await picker.inputValue();
  expect(sansAlias).toMatch(/^wdoc-/);

  await editor.evaluate(element => {
    const text = element.querySelector('span')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 9); range.setEnd(text, 14);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    element.focus();
  });
  await search.fill('lora');
  await picker.selectOption('google:Lora');
  await expect(picker).toBeEnabled();
  await expect(editor.locator('span[style*="font-family"]')).toHaveCount(3);
  expect(await editor.locator('span').nth(1).textContent()).toBe('serif');
  const serifAlias = await picker.inputValue();
  expect(serifAlias).not.toBe(sansAlias);
  await expect(page.getByRole('heading', { name: 'Load external fonts?' })).toHaveCount(0);
  await search.fill('no such font family');
  await expect(page.locator('app-document-editor').getByRole('status')).toContainText('0 Google Fonts found');
  await expect(picker.locator('optgroup[label="Document fonts"] option')).toHaveCount(2);

  await page.getByLabel('Include fonts for offline viewing', { exact: true }).check();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save document', exact: true }).click();
  const bytes = await readFile((await (await downloaded).path())!);
  const archive = await JSZip.loadAsync(bytes);
  const content = await archive.file('index.html')!.async('text');
  expect(content).toContain('font-family: Inter');
  expect(content).toContain('font-family: Lora');
  expect(content).not.toMatch(/wdoc-[0-9a-f]{8}-/);
  const manifest = JSON.parse(await archive.file('manifest.json')!.async('text'));
  expect(Object.keys(manifest.content.externalFonts)).toHaveLength(2);
  let outbound = 0;
  await page.reload();
  await page.route('https://**/*', route => { outbound++; return route.abort(); });
  await page.locator('app-navbar input[type=file]').setInputFiles({ name: 'mixed-fonts.wdoc', mimeType: 'application/zip', buffer: bytes });
  await expect(page.locator('app-viewer').getByText('Sans and serif.')).toBeVisible();
  const families = await page.locator('app-viewer p span').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontFamily));
  expect(new Set(families).size).toBe(2);
  expect(families.every(family => family.includes('wdoc-'))).toBe(true);
  expect(outbound).toBe(0);
});

test('opens the six-family Google Fonts example without bundled font files or a permission prompt', async ({page}) => {
  await page.route('https://fonts.googleapis.com/css2?*', route => {
    const families = new URL(route.request().url()).searchParams.getAll('family');
    return route.fulfill({ status: 200, contentType: 'text/css', body: families.map(family => `@font-face{font-family:"${family}";src:url("https://fonts.gstatic.com/s/${family.replaceAll(' ', '').toLowerCase()}/regular.ttf")}`).join('\n') });
  });
  await page.route('https://fonts.gstatic.com/s/**', route => route.fulfill({ status: 200, contentType: 'font/ttf', body: font }));
  const example = join(__dirname, '../../examples.wdoc.info/unit_test/google_fonts.wdoc');
  const archive = await JSZip.loadAsync(await readFile(example));
  expect(Object.keys(archive.files)).toEqual(['index.html']);
  expect(await archive.file('index.html')!.async('text')).toBe(await readFile(join(__dirname, '../../examples.wdoc.info/unpacked/unit_test/google_fonts/index.html'), 'utf8'));
  await page.goto('/');
  await page.locator('app-navbar input[type=file]').setInputFiles(example);
  await expect(page.locator('app-viewer').getByText('Six families, one document')).toBeVisible();
  const families = await page.locator('app-viewer .sample span').evaluateAll(elements => elements.map(element => getComputedStyle(element).fontFamily));
  expect(families).toHaveLength(6);
  expect(new Set(families).size).toBe(6);
  expect(families.every(family => family.includes('wdoc-'))).toBe(true);
  await expect(page.getByRole('heading', { name: 'Load external fonts?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Update document', exact: true }).click();
  await expect(page.getByLabel('Document font').locator('optgroup[label="Document fonts"] option')).toHaveCount(6);
});
