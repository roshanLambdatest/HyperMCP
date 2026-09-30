import { test } from '@playwright/test';
test('login @smoke', async ({ page }) => { await page.goto(process.env.BASE_URL!); });
