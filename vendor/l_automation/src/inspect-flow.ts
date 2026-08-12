import { writeFileSync } from "node:fs";
import type { Locator, Page } from "playwright";
import { loadConfig } from "./config.js";
import { launchContext, getPage, snapshot } from "./browser.js";
import { sleep, newestFile } from "./utils.js";
import { log } from "./logger.js";

async function firstVisibleHelper(
  page: Page,
  selectors: string[],
  timeoutMs = 5000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        /* keep trying */
      }
    }
    await sleep(300);
  }
  return null;
}

/**
 * Dev-only helper: open Google Flow with the logged-in profile and dump the
 * real DOM controls (file inputs, buttons, editable fields) so the automation
 * selectors in flow.ts can be hardened against the actual UI.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const context = await launchContext(cfg);
  const page = await getPage(context);

  log.step(`Opening Flow: ${cfg.flow.url}`);
  await page.goto(cfg.flow.url, { waitUntil: "domcontentloaded" });
  await sleep(6000);

  // The landing page is a project dashboard; the editor (prompt + upload) is
  // only available inside a project. Open a new project before inspecting.
  log.step("Entering a project (New project)...");
  const newProject = page
    .locator('button:has-text("New project"), button:has-text("New Project")')
    .first();
  try {
    if (await newProject.isVisible()) {
      await newProject.click();
      log.ok("Clicked New project.");
    } else {
      const firstProject = page.locator('button:has-text("Edit project")').first();
      if (await firstProject.isVisible()) {
        await firstProject.click();
        log.ok("Opened an existing project.");
      }
    }
  } catch (err) {
    log.warn(`Could not open a project automatically: ${(err as Error).message}`);
  }

  // Wait for navigation into the project editor first.
  log.step("Waiting for the project editor URL...");
  try {
    await page.waitForURL(/\/project\//, { timeout: 30_000 });
    log.ok(`In project: ${page.url()}`);
  } catch {
    log.warn("Did not detect a /project/ URL.");
  }

  // The editor shows a full-screen "Loading..." for a while. First confirm the
  // loading screen has appeared (so we don't match the stale dashboard), then
  // wait for it to clear and real controls to render.
  log.step("Waiting for the loading screen to appear...");
  await page
    .waitForFunction(() => /Loading/i.test(document.body.innerText || ""), {
      timeout: 20_000,
    })
    .catch(() => log.warn("Did not observe a loading screen."));

  log.step("Waiting for the editor to finish loading...");
  try {
    await page.waitForFunction(
      () => {
        const bodyText = (document.body.innerText || "").trim();
        const stillLoading = bodyText.length < 15 && /Loading/i.test(bodyText);
        const buttons = document.querySelectorAll("button").length;
        return !stillLoading && buttons > 2;
      },
      { timeout: 120_000, polling: 1000 },
    );
    log.ok("Editor rendered.");
  } catch {
    log.warn("Editor did not finish loading within 120s; dumping anyway.");
  }
  await sleep(5000);

  const report = await page.evaluate(() => {
    // NOTE: use function declarations (not `const x = () =>`) so the tsx/esbuild
    // `__name` name-keeping helper is not injected into browser-context code.
    function describe(el: Element) {
      const e = el as HTMLElement;
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute("type"),
        id: e.id || null,
        name: e.getAttribute("name"),
        ariaLabel: e.getAttribute("aria-label"),
        placeholder: e.getAttribute("placeholder"),
        title: e.getAttribute("title"),
        role: e.getAttribute("role"),
        dataTestId:
          e.getAttribute("data-test-id") || e.getAttribute("data-testid"),
        text: (e.innerText || "").trim().slice(0, 60),
        accept: e.getAttribute("accept"),
        contentEditable: e.getAttribute("contenteditable"),
        visible: !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length),
      };
    }
    function pick(sel: string) {
      return Array.from(document.querySelectorAll(sel)).map(describe);
    }
    return {
      url: location.href,
      title: document.title,
      fileInputs: pick('input[type="file"]'),
      buttons: pick("button"),
      editables: pick('textarea, [contenteditable="true"], input[type="text"]'),
    };
  });

  // Configure Video + Ingredients + 9:16, then dump the ingredient-attach UI.
  let modelMenu: unknown = null;
  const dumpInteractive = () =>
    page.evaluate(() => {
      const out: {
        tag: string;
        type: string | null;
        accept: string | null;
        role: string | null;
        ariaLabel: string | null;
        className: string;
        text: string;
      }[] = [];
      const seen = new Set<string>();
      const nodes = Array.from(
        document.querySelectorAll(
          'button, [role], [tabindex], input, select, option, label',
        ),
      );
      for (const el of nodes) {
        const e = el as HTMLElement;
        const visible = !!(
          e.offsetWidth ||
          e.offsetHeight ||
          e.getClientRects().length
        );
        const isFile = e.getAttribute("type") === "file";
        if (!visible && !isFile) continue;
        const text = (e.innerText || "").trim().slice(0, 50);
        const role = e.getAttribute("role");
        const key = e.tagName + "|" + role + "|" + text + "|" + (e.getAttribute("accept") || "");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tag: e.tagName.toLowerCase(),
          type: e.getAttribute("type"),
          accept: e.getAttribute("accept"),
          role,
          ariaLabel: e.getAttribute("aria-label"),
          className:
            typeof e.className === "string" ? e.className.slice(0, 50) : "",
          text,
        });
      }
      return out;
    });

  try {
    const chip = page
      .locator(
        [
          'button:has-text("Nano Banana")',
          'button:has-text("Omni Flash")',
          'button:has-text("Veo")',
          'button:has-text("Video \u00b7")',
          'button:has-text("crop_16_9")',
          'button:has-text("crop_9_16")',
        ].join(", "),
      )
      .last();
    await chip.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    if (await chip.isVisible()) {
      await chip.click();
      await sleep(2000);
      await snapshot(page, "flow_popover_open");

      const videoTab = await firstVisibleHelper(page, [
        'button[role="tab"]:has-text("Video")',
      ]);
      if (videoTab) {
        await videoTab.click();
        await sleep(1200);
      }
      const ingredientsTab = await firstVisibleHelper(page, [
        'button[role="tab"]:has-text("Ingredients")',
      ]);
      if (ingredientsTab) {
        await ingredientsTab.click();
        await sleep(1200);
        log.ok("Selected Ingredients sub-tab.");
      } else {
        log.warn("Ingredients tab not found.");
      }
      const ratio = await firstVisibleHelper(page, [
        'button[role="tab"]:has-text("9:16")',
      ]);
      if (ratio) {
        await ratio.click();
        await sleep(1000);
        log.ok("Selected 9:16.");
      }
      await snapshot(page, "flow_ingredients_popover");
      const popoverConfigured = await dumpInteractive();

      // Close the popover and inspect the prompt-area ingredient controls.
      await page.keyboard.press("Escape").catch(() => {});
      await sleep(1500);
      await snapshot(page, "flow_ingredients_ready");
      const promptArea = await dumpInteractive();

      // Click the prompt-bar "+" (add_2) to reveal the ingredient-add menu.
      let addMenu: unknown = null;
      let afterUpload: unknown = null;
      const plus = await firstVisibleHelper(page, [
        'button:has-text("add_2")',
      ]);
      if (plus) {
        await plus.click().catch(() => {});
        await sleep(1500);
        await snapshot(page, "flow_add_menu");
        addMenu = await dumpInteractive();

        // Actually upload an image and observe whether it auto-attaches.
        const img = newestFile("downloads/images", [".jpg", ".png", ".webp"]);
        if (img) {
          log.info(`Uploading test image: ${img}`);
          const fileInput = page.locator('input[type="file"][accept*="image"]');
          if ((await fileInput.count().catch(() => 0)) > 0) {
            await fileInput.first().setInputFiles(img).catch((e) => {
              log.warn(`setInputFiles failed: ${(e as Error).message}`);
            });
          }
          await sleep(6000);
          await snapshot(page, "flow_after_upload");
          afterUpload = await dumpInteractive();
        } else {
          log.warn("No image found in downloads/images to test upload.");
        }
      } else {
        log.warn('Prompt-bar "+" (add_2) not found.');
      }

      modelMenu = { popoverConfigured, promptArea, addMenu, afterUpload };
    }
  } catch (err) {
    log.warn(`Ingredients inspect failed: ${(err as Error).message}`);
  }

  const out = "artifacts/flow-inspect.json";
  writeFileSync(out, JSON.stringify({ ...report, modelMenu }, null, 2));
  await snapshot(page, "flow_inspect");

  log.ok(`URL: ${report.url}`);
  log.ok(`Title: ${report.title}`);
  log.info(`file inputs: ${report.fileInputs.length}`);
  log.info(`buttons: ${report.buttons.length}`);
  log.info(`editable fields: ${report.editables.length}`);
  log.ok(`Full report written to ${out}`);

  log.info("Leaving the browser open for 60s so you can interact if needed...");
  await sleep(60_000);
  await context.close();
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
