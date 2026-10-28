import { defineConfig, devices } from '@playwright/test';

// The e2e server runs on its own ports (3100/3101) so it can run next to `npm run dev`.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', trace: 'retain-on-failure', ...devices['Desktop Chrome'] },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx tsx tests/e2e/server.ts',
    url: 'http://localhost:3100/health',
    timeout: 60_000,
    reuseExistingServer: false,
    stdout: 'pipe',
  },
});
