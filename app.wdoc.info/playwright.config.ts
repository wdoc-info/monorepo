import type { PlaywrightTestConfig } from '@playwright/test';

const config: PlaywrightTestConfig = {
  testDir: 'e2e',
  retries: 0,
  webServer: {
    command: 'npx ng serve --port 4200 --configuration development',
    port: 4200,
    timeout: 120 * 1000,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: 'http://localhost:4200',
    headless: true,
  },
};

export default config;
