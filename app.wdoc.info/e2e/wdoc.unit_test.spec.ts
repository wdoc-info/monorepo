import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'path';

const examplesDir = path.resolve(__dirname, '../examples/unit_test');

async function loadExample(page: Page, name: string) {
  const wdoc = path.join(examplesDir, `${name}.wdoc`);
  await page.locator('input[type=file]').setInputFiles(wdoc);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('hello_world example renders', async ({ page }) => {
  await loadExample(page, 'hello_world');
  await expect(page.locator('wdoc-page h1')).toHaveText('Hello, World!');
});

test('already_paginated keeps pages', async ({ page }) => {
  await loadExample(page, 'already_paginated');
  await expect(page.locator('wdoc-page')).toHaveCount(2);
});

test('not_paginated creates multiple pages', async ({ page }) => {
  await loadExample(page, 'not_paginated');
  await expect(page.locator('wdoc-page')).toHaveCount(2);
});

test('form example displays form', async ({ page }) => {
  await loadExample(page, 'form');
  await expect(page.locator('wdoc-page form')).toHaveCount(1);
});

test('url query parameter loads remote .wdoc', async ({ page }) => {
  const encodedUrl = encodeURIComponent(
    'https://cdn.pandopia.com/already_paginated.wdoc'
  );
  await page.goto(`/?url=${encodedUrl}`);
  await expect(page.locator('wdoc-page')).toHaveCount(2);
});
