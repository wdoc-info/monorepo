import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'path';

const examplesDir = path.resolve(__dirname, '../examples/security');

async function loadExample(page: Page, name: string) {
  const wdoc = path.join(examplesDir, `${name}.wdoc`);
  await page.locator('input[type=file]').setInputFiles(wdoc);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('internal_script example strips scripts', async ({ page }) => {
  await loadExample(page, 'internal_script');
  await expect(page.locator('wdoc-container h1')).toHaveText('Internal script');
  await expect(page.locator('wdoc-container script')).toHaveCount(0);
});

test('internal_image example embeds images', async ({ page }) => {
  await loadExample(page, 'internal_image');
  const src = await page.locator('wdoc-page img').getAttribute('src');
  expect(src).toMatch(/^data:image\//);
});

test('external_image example loads after confirm', async ({ page }) => {
  page.once('dialog', (dialog) => dialog.accept());
  await loadExample(page, 'external_image');
  await expect(page.locator('wdoc-page img')).toHaveAttribute(
    'src',
    /logo.png/
  );
});

test('image_changed example warns about signature mismatch', async ({
  page,
}) => {
  const dialogPromise = page.waitForEvent('dialog');
  await loadExample(page, 'image_changed');
  const dialog = await dialogPromise;
  expect(dialog.message()).toContain('does not match its manifest');
  await dialog.dismiss();
  await expect(page.locator('wdoc-container')).toHaveCount(0);
});
