import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
let executablePath = process.env['CHROME_BIN'];
// Reuse the monorepo's installed Chromium locally; CI uses Playwright Chromium.
if (!executablePath) {
    try {
        const require = createRequire(new URL('../app.wdoc.info/package.json', import.meta.url));
        const candidate = require('puppeteer').executablePath();
        if (existsSync(candidate))
            executablePath = candidate;
    }
    catch { /* A standalone checkout can install Chromium with Playwright. */ }
}
export default defineConfig({
    testDir: 'e2e', fullyParallel: false, workers: 1, retries: 0,
    webServer: { command: 'npm start -- --host 127.0.0.1', url: 'http://127.0.0.1:4300', timeout: 120000, reuseExistingServer: !process.env['CI'] },
    use: { baseURL: 'http://127.0.0.1:4300', headless: true, viewport: { width: 1440, height: 1050 }, launchOptions: { ...(executablePath ? { executablePath } : {}) }, screenshot: 'only-on-failure' },
});
