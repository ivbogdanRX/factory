/**
 * One-off probe: is ChatGPT logged in inside the automation browser profile?
 * Flags: --json prints a machine-readable line; PROBE_HEADLESS=1 runs headless
 * (used by the orchestrator's weekly healthcheck).
 */
import { loadConfig } from "../src/config.js";
import { withBrowser } from "../src/browser.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const asJson = process.argv.includes("--json");
  const headless = process.env.PROBE_HEADLESS === "1";
  await withBrowser(cfg, { headless }, async (_ctx, page) => {
    await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const loggedOut =
      /auth|login/i.test(page.url()) ||
      (await page
        .locator('button:has-text("Log in"), [data-testid="login-button"]')
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false));
    const composer = await page
      .locator("#prompt-textarea")
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (asJson) {
      console.log(JSON.stringify({ url: page.url(), loggedOut, composerVisible: composer }));
    } else {
      console.log("URL:", page.url());
      console.log("loggedOut:", loggedOut, "| composerVisible:", composer);
      await page.screenshot({ path: "/tmp/chatgpt-probe.png" });
    }
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
