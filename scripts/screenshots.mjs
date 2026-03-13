import { chromium } from 'playwright';

const BASE = process.env.BASE_URL || 'http://localhost:9211';

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  // 1. Accounts page (home)
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'docs/accounts.png' });
  console.log('Saved docs/accounts.png');

  // 2. Configs page
  await page.click('a[href="/configs"], button:has-text("Configs"), [data-page="configs"]');
  await page.waitForTimeout(1000);
  // Try clicking via sidebar nav
  const configsLink = page.locator('text=Configs').first();
  if (await configsLink.count() > 0) {
    await configsLink.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'docs/configs.png' });
  console.log('Saved docs/configs.png');

  // 3. Guardrails page
  const guardsLink = page.locator('text=Guardrails').first();
  if (await guardsLink.count() > 0) {
    await guardsLink.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'docs/guardrails.png' });
  console.log('Saved docs/guardrails.png');

  // 4. Logs page
  const logsLink = page.locator('text=Logs').first();
  if (await logsLink.count() > 0) {
    await logsLink.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'docs/logs.png' });
  console.log('Saved docs/logs.png');

  // 5. Settings page
  const settingsLink = page.locator('text=Settings').first();
  if (await settingsLink.count() > 0) {
    await settingsLink.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'docs/settings.png' });
  console.log('Saved docs/settings.png');

  // 6. Setup page
  const setupLink = page.locator('text=Setup').first();
  if (await setupLink.count() > 0) {
    await setupLink.click();
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'docs/setup.png' });
  console.log('Saved docs/setup.png');

  await browser.close();
  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
