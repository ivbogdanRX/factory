/**
 * Quick health probe: open Flow in the persistent browser profile and report
 * whether the Google session is still logged in (no render, no project).
 */
import { loadConfig } from "../src/config.js";
import { withBrowser } from "../src/browser.js";

const cfg = loadConfig();

await withBrowser(cfg, {}, async (_context, page) => {
  await page.goto(cfg.flow.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(4000);

  let signedOut = false;
  for (const sel of ['a[href*="accounts.google.com"]', "text=/^sign in$/i"]) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 1500 })) {
        signedOut = true;
        break;
      }
    } catch {
      /* selector not present */
    }
  }

  const hasProjectUi = await page
    .locator('button:has-text("New project"), button:has-text("New Project")')
    .first()
    .isVisible({ timeout: 8000 })
    .catch(() => false);

  console.log(JSON.stringify({ url: page.url(), signedOut, hasProjectUi }));
});
