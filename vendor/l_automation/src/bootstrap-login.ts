import { loadConfig } from "./config.js";
import { launchContext, getPage } from "./browser.js";
import { waitForEnter } from "./utils.js";
import { log } from "./logger.js";

/**
 * One-time (occasional) helper: opens Pinterest and Google Flow so you can
 * log in manually. Credentials are stored in the persistent browser profile
 * and reused by the main automation, so logins/CAPTCHAs stay human-in-the-loop.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.browser.headless) {
    log.warn(
      "browser.headless is true. For login bootstrap you want a visible browser. " +
        "Set browser.headless=false in config.json.",
    );
  }

  const context = await launchContext(cfg);
  const page = await getPage(context);

  log.step("Opening Pinterest for login...");
  await page.goto("https://www.pinterest.com/login/", { waitUntil: "domcontentloaded" });
  await waitForEnter("Log in to Pinterest in the browser window, then return here.");

  log.step("Opening Google Flow for login...");
  await page.goto(cfg.flow.url, { waitUntil: "domcontentloaded" });
  await waitForEnter(
    "Log in to Google / open Flow so the tool is ready, then return here.",
  );

  log.step("Opening ChatGPT for login (used by the 'chatgpt' image source)...");
  await page.goto(cfg.imageSource.chatgpt.url, { waitUntil: "domcontentloaded" });
  await waitForEnter(
    "Log in to ChatGPT (Continue with Google works) so image generation is ready, then return here.",
  );

  log.ok("Login state saved to the persistent profile. You can now run: npm run run");
  await context.close();
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
