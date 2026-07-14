import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { startWorkbench } from "../src/workbench/server";
import { pngBytes, svgResult } from "./helpers";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

describe("workbench browser contract", () => {
  test("uses cookie auth, token-free resources, and intact recipe-card geometry", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-test-"));
    const instance = await startWorkbench({ port: 0, mock: true, storageRoot: root });
    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => browser.close());
    cleanup.push(async () => instance.server.stop(true));

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(instance.url, { waitUntil: "networkidle" });
    expect(page.url()).toBe(`${new URL(instance.url).origin}/`);

    const desktop = await page.locator(".recipe-option").evaluateAll((labels) =>
      labels.map((label) => {
        const card = label.querySelector(".recipe-card");
        const labelBox = label.getBoundingClientRect();
        const cardBox = card?.getBoundingClientRect();
        return {
          labelWidth: labelBox.width,
          cardWidth: cardBox?.width ?? 0,
          cardHeight: cardBox?.height ?? 0,
          rects: card?.getClientRects().length ?? 0,
          display: card ? getComputedStyle(card).display : "",
        };
      }),
    );
    expect(desktop).toHaveLength(4);
    expect(
      desktop.every(
        (card) =>
          card.display === "block" &&
          card.rects === 1 &&
          card.cardWidth === card.labelWidth &&
          card.cardWidth > 180 &&
          card.cardHeight > 70,
      ),
    ).toBe(true);

    const flatRecipe = page.locator('.recipe-option:has(input[value="folio-flat-cut-paper"])');
    await flatRecipe.locator("input").focus();
    expect(
      await flatRecipe
        .locator(".recipe-card")
        .evaluate((card) => getComputedStyle(card).outlineWidth),
    ).toBe("3px");
    await page.keyboard.press("Space");
    expect(await flatRecipe.locator("input").isChecked()).toBe(true);
    expect(await flatRecipe.locator(".checked").isVisible()).toBe(true);
    expect(await page.locator("#call-estimate").textContent()).toBe(
      "2 styles × 4 variants = 8 calls",
    );
    await page.keyboard.press("Space");
    expect(await page.locator("label.field").first().textContent()).toContain(
      "Prompt / subject brief",
    );
    expect(await page.locator("#subject").getAttribute("placeholder")).toContain("complete prompt");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileWidths = await page
      .locator(".recipe-card")
      .evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().width));
    expect(mobileWidths.every((width) => width > 300 && width < 390)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.fill("#subject", "Browser regression test icon.");
    await page.setInputFiles("#references", {
      name: "reference.png",
      mimeType: "image/png",
      buffer: Buffer.from(pngBytes()),
    });
    await page.fill("#variants", "4");
    await page.click("#generate-button");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".candidate-state")].filter(
          (element) => element.textContent === "succeeded",
        ).length === 4,
    );
    expect(await page.locator(".arm-prompt").count()).toBe(1);
    expect(await page.locator(".candidate details.prompt").count()).toBe(0);
    const nativeGeometry = await page.locator(".native-row").evaluateAll((rows) =>
      rows.map((row) => {
        const images = row.querySelectorAll("img");
        const light = images[0]?.getBoundingClientRect();
        const dark = images[1]?.getBoundingClientRect();
        return {
          declared: Number(row.querySelector("span")?.textContent?.replace("px", "")),
          lightWidth: light?.width,
          lightHeight: light?.height,
          darkWidth: dark?.width,
          darkHeight: dark?.height,
          sideBySide: Boolean(light && dark && dark.left > light.right),
        };
      }),
    );
    expect(
      nativeGeometry.every(
        (preview) =>
          preview.lightWidth === preview.declared &&
          preview.lightHeight === preview.declared &&
          preview.darkWidth === preview.declared &&
          preview.darkHeight === preview.declared &&
          preview.sideBySide,
      ),
    ).toBe(true);
    expect(
      await page.locator(".candidate-grid").evaluate((grid) => grid.scrollWidth > grid.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileNativeGeometry = await page.locator(".native-row").evaluateAll((rows) =>
      rows.map((row) => {
        const images = row.querySelectorAll("img");
        const light = images[0]?.getBoundingClientRect();
        const dark = images[1]?.getBoundingClientRect();
        return {
          declared: Number(row.querySelector("span")?.textContent?.replace("px", "")),
          lightWidth: light?.width,
          darkWidth: dark?.width,
          sideBySide: Boolean(light && dark && dark.left > light.right),
        };
      }),
    );
    expect(
      mobileNativeGeometry.every(
        (preview) =>
          preview.lightWidth === preview.declared &&
          preview.darkWidth === preview.declared &&
          preview.sideBySide,
      ),
    ).toBe(true);
    expect(
      await page.locator(".candidate-grid").evaluate((grid) => grid.scrollWidth > grid.clientWidth),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.locator('[data-select="candidate-1-1"]').click();
    await page.waitForSelector('[data-candidate="candidate-1-1"] .selection-badge');
    expect(
      await page.locator('[data-candidate="candidate-1-1"] [data-select]').textContent(),
    ).toContain("Selected");
    await page.locator('[data-export="candidate-1-1"]').click();
    await page.waitForSelector("[data-export-record]");
    const exportText = await page.locator("[data-export-record]").textContent();
    expect(exportText).toContain(root);
    expect(exportText).toContain("raw.svg");
    expect(exportText).toContain("production.png");
    expect(exportText).toContain("manifest.json");
    expect(exportText).toContain("references/");
    const resourceUrls = await page.evaluate(() =>
      performance.getEntriesByType("resource").map((entry) => entry.name),
    );
    expect(resourceUrls.some((url) => url.includes("token="))).toBe(false);
    expect(await page.locator(".raw-preview").first().getAttribute("src")).not.toContain("token=");
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator(".history-item").count()).toBe(1);
    const mobileOrder = await page.evaluate(() => ({
      historyTop: document.querySelector(".history-panel")?.getBoundingClientRect().top,
      editorTop: document.querySelector(".editor")?.getBoundingClientRect().top,
    }));
    expect(Number(mobileOrder.historyTop)).toBeLessThan(Number(mobileOrder.editorTop));
    await page.locator(".history-item").click();
    await page.waitForSelector("[data-export-record]");
    expect(await page.locator("[data-export-record]").textContent()).toContain("production.png");
    expect(page.url()).toBe(`${new URL(instance.url).origin}/`);
  });

  test("keeps the billing warning visible after an in-flight abort", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-cancel-test-"));
    const instance = await startWorkbench({
      port: 0,
      storageRoot: root,
      runner: (request) =>
        new Promise((_resolve, reject) => {
          request.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => browser.close());
    cleanup.push(async () => instance.server.stop(true));

    const page = await browser.newPage();
    await page.goto(instance.url, { waitUntil: "networkidle" });
    await page.fill("#subject", "Cancellation warning test.");
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-state:text-is("running")');
    await page.click("#cancel");
    await page.waitForSelector('.candidate-state:text-is("cancel-requested")');
    await expect(page.locator(".candidate-message").textContent()).resolves.toContain(
      "billing may still occur",
    );
  });

  test("preserves focused candidate controls and open prompt across polls", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-poll-test-"));
    let invocation = 0;
    let failSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      failSecond = resolve;
    });
    const instance = await startWorkbench({
      port: 0,
      storageRoot: root,
      runner: async () => {
        invocation++;
        if (invocation === 1) return svgResult("ready");
        await second;
        throw new Error("deliberate second-variant failure");
      },
    });
    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => browser.close());
    cleanup.push(async () => instance.server.stop(true));

    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    let sessionGets = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && /\/api\/sessions\/[^/]+$/.test(request.url())) {
        sessionGets++;
      }
    });
    await page.goto(instance.url, { waitUntil: "networkidle" });
    await page.fill("#subject", "Polling stability test.");
    await page.fill("#variants", "2");
    await page.click("#generate-button");
    await page.waitForSelector(
      '[data-candidate="candidate-1-1"] .candidate-state:text-is("succeeded")',
    );
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-state:text-is("running")',
    );
    const prompt = page.locator(".arm-prompt");
    await prompt.locator("summary").click();

    const select = page.locator('[data-candidate="candidate-1-1"] [data-select]');
    const selectHandle = await select.elementHandle();
    await select.focus();
    await page.waitForTimeout(1_050);
    expect(
      await selectHandle?.evaluate(
        (element) => element.isConnected && document.activeElement === element,
      ),
    ).toBe(true);
    expect(await prompt.getAttribute("open")).not.toBeNull();

    const exportButton = page.locator('[data-candidate="candidate-1-1"] [data-export]');
    const exportHandle = await exportButton.elementHandle();
    await exportButton.focus();
    await page.waitForTimeout(1_050);
    expect(
      await exportHandle?.evaluate(
        (element) => element.isConnected && document.activeElement === element,
      ),
    ).toBe(true);
    expect(await prompt.getAttribute("open")).not.toBeNull();

    await page.route("**/select", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Select failed visibly" } }),
      }),
    );
    await select.click();
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Select failed visibly"),
    );
    expect(
      await page
        .locator("#session-message")
        .evaluate((element) => element.classList.contains("error")),
    ).toBe(true);
    await page.unroute("**/select");

    await page.route("**/cancel", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Cancel failed visibly" } }),
      }),
    );
    await page.click("#cancel");
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Cancel failed visibly"),
    );
    await page.unroute("**/cancel");

    await page.route("**/api/history", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "History failed visibly" } }),
      }),
    );
    await page.click("#history-refresh");
    await page.waitForSelector("#history-list .error");
    expect(await page.locator("#history-list").textContent()).toContain("History failed visibly");
    await page.unroute("**/api/history");

    failSecond();
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-state:text-is("failed")',
    );
    expect(await prompt.getAttribute("open")).not.toBeNull();
    expect(await page.locator(".arm-prompt").count()).toBe(1);
    const terminalGets = sessionGets;
    await page.waitForTimeout(1_100);
    expect(sessionGets).toBe(terminalGets);
  }, 30_000);

  test("disables project-icon export when provider output is not square", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-square-test-"));
    const instance = await startWorkbench({
      port: 0,
      storageRoot: root,
      runner: async () => ({
        images: [
          {
            bytes: new TextEncoder().encode(
              '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="white"/></svg>',
            ),
            mimeType: "image/svg+xml",
          },
        ],
        text: [],
        cost: { status: "calculated", usd: 0, excludesGrounding: false },
      }),
    });
    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => browser.close());
    cleanup.push(async () => instance.server.stop(true));

    const page = await browser.newPage();
    await page.goto(instance.url, { waitUntil: "networkidle" });
    await page.fill("#subject", "Non-square export guard.");
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-state:text-is("succeeded")');
    expect(await page.locator("[data-export]").isDisabled()).toBe(true);
    expect(await page.locator(".candidate-message").textContent()).toContain(
      "project icons require a square generated image",
    );
  });

  test("disables generation and shows exact setup guidance when the key is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-no-key-test-"));
    const previous = process.env.NANO_BANANA_TEST_NO_API_KEY;
    process.env.NANO_BANANA_TEST_NO_API_KEY = "1";
    let instance: Awaited<ReturnType<typeof startWorkbench>>;
    try {
      instance = await startWorkbench({ port: 0, storageRoot: root });
    } finally {
      if (previous === undefined) delete process.env.NANO_BANANA_TEST_NO_API_KEY;
      else process.env.NANO_BANANA_TEST_NO_API_KEY = previous;
    }
    const browser = await chromium.launch({ headless: true });
    cleanup.push(async () => rm(root, { recursive: true, force: true }));
    cleanup.push(async () => browser.close());
    cleanup.push(async () => instance.server.stop(true));

    const page = await browser.newPage();
    await page.goto(instance.url, { waitUntil: "networkidle" });
    expect(await page.locator("#generate-button").isDisabled()).toBe(true);
    expect(await page.locator("#key-status").textContent()).toBe("API key not configured");
    const guidance = await page.locator("#key-guidance").textContent();
    expect(guidance).toContain("GEMINI_API_KEY");
    expect(guidance).toContain("~/.nano-banana/.env");
    expect(guidance).toContain("restart");
  });
});
