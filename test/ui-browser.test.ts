import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium, type Page, type Request } from "playwright";

import { startWorkbench, type WorkbenchOptions } from "../src/workbench/server";
import { pngBytes } from "./helpers";

let browser: Browser;
const cleanup: Array<() => Promise<void>> = [];

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});

async function openWorkbench(
  options: WorkbenchOptions = {},
  viewport = { width: 1440, height: 1000 },
  initScript?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-test-"));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const instance = await startWorkbench({ port: 0, mock: true, storageRoot: root, ...options });
  cleanup.push(async () => instance.server.stop(true));
  const context: BrowserContext = await browser.newContext({ viewport });
  cleanup.push(async () => context.close());
  if (initScript) await context.addInitScript(initScript);
  const page: Page = await context.newPage();
  await page.goto(instance.url, { waitUntil: "networkidle" });
  return { instance, page, root };
}

async function generate(page: Page, subject: string, variants: number) {
  await page.fill("#subject", subject);
  await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
    details.open = true;
  });
  await page.fill("#variants", String(variants));
  await page.click("#generate-button");
  await page.waitForFunction(
    (count) => document.querySelector("#progress")?.textContent?.includes(`${count} succeeded`),
    variants,
  );
}

async function placeholderContrast(page: Page) {
  return page.locator("#subject").evaluate((element) => {
    const probe = document.createElement("style");
    probe.textContent = "";
    const parse = (color: string) => color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance = (color: string) => {
      const [red, green, blue] = parse(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const foreground = getComputedStyle(element, "::placeholder").color;
    const background = getComputedStyle(element).backgroundColor;
    const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
  });
}

async function elementContrast(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const parse = (color: string) => color.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    const luminance = (color: string) => {
      const [red, green, blue] = parse(color).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return red * 0.2126 + green * 0.7152 + blue * 0.0722;
    };
    const style = getComputedStyle(element);
    const [lighter, darker] = [luminance(style.color), luminance(style.backgroundColor)].sort(
      (a, b) => b - a,
    );
    return (lighter + 0.05) / (darker + 0.05);
  });
}

describe("workbench browser contract", () => {
  test("uses a collapsed history rail, accessible candidate identity, and a no-scroll contact sheet", async () => {
    const { page } = await openWorkbench();

    expect(await page.locator("#history-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(await page.locator("#history-toggle").getAttribute("title")).toBe("Show history");
    expect(await page.locator("#history-drawer").isHidden()).toBe(true);
    expect(await page.locator("#theme-toggle").getAttribute("aria-pressed")).toBe("false");
    expect(await page.locator("#theme-toggle").getAttribute("aria-label")).toBe(
      "Switch to dark theme",
    );
    await page.click("#theme-toggle");
    expect(await page.locator("#theme-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("#theme-toggle").getAttribute("aria-label")).toBe(
      "Switch to light theme",
    );
    expect(
      await page.locator(".brand-mark").evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(24, 24, 27)");
    expect(
      await page.locator("#generate-button").evaluate((element) => getComputedStyle(element).color),
    ).toBe("rgb(24, 24, 27)");
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.locator("#theme-toggle").getAttribute("aria-pressed")).toBe("true");

    expect(await page.locator("#subject-count").textContent()).toBe("0 / 12,000");
    expect(await placeholderContrast(page)).toBeGreaterThanOrEqual(4.5);
    await page.click("#theme-toggle");
    expect(await placeholderContrast(page)).toBeGreaterThanOrEqual(4.5);
    await page.fill("#subject", "A focused lighthouse icon.");
    expect(await page.locator("#subject-count").textContent()).toBe("26 / 12,000");

    const flat = page.locator('input[name="recipe"][value="folio-flat-cut-paper"]');
    const custom = page.locator('input[name="recipe"][value="custom"]');
    await flat.check();
    await custom.check();
    expect(await page.locator("#recipe-feedback").textContent()).toContain(
      "Custom replaces the selected Folio style recipes",
    );
    expect(await custom.isChecked()).toBe(true);
    expect(await flat.isChecked()).toBe(false);
    await custom.click();
    expect(await custom.isChecked()).toBe(true);
    expect(await page.locator("#recipe-feedback").textContent()).toContain(
      "At least one style recipe is required",
    );
    await page.locator('input[name="recipe"][value="folio-geometric-isometric"]').check();

    let releaseCreate!: () => void;
    const createPaused = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    await page.route("**/api/sessions", async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      await createPaused;
      await route.continue();
    });
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "4");
    await page.click("#generate-button");
    expect(await page.locator("#generate-button").textContent()).toBe("Generating…");
    expect(await page.locator("#session-view").isVisible()).toBe(true);
    expect(await page.locator("#progress").textContent()).toContain("Preparing candidates");
    expect(
      await page
        .locator("#session-title")
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    expect(
      await page.locator("#session-title").evaluate((element) => getComputedStyle(element).outline),
    ).not.toContain("none");
    expect(await page.locator("#regenerate").isDisabled()).toBe(true);
    expect(await page.locator("#cancel").isDisabled()).toBe(true);
    expect(await page.locator("#edit-setup").isDisabled()).toBe(true);
    releaseCreate();
    await page.waitForFunction(() =>
      document.querySelector("#progress")?.textContent?.includes("4 succeeded"),
    );
    await page.unroute("**/api/sessions");

    expect(await page.locator("#run-summary").isVisible()).toBe(true);
    expect(await page.locator(".editor-fields").isHidden()).toBe(true);
    const first = page.locator('[data-candidate="candidate-1-1"]');
    expect(await first.getAttribute("aria-label")).toBe(
      "Folio geometric isometric → A focused lighthouse icon. → Variant 1 of 4",
    );
    expect(await first.locator("img").getAttribute("alt")).toBe(
      "Generated Folio geometric isometric → A focused lighthouse icon. → Variant 1 of 4",
    );
    expect(await first.locator(".candidate-label span").count()).toBe(0);
    expect(await first.locator(".export-check").textContent()).toBe("Export");
    expect(await first.locator("[data-export-select]").getAttribute("aria-label")).toContain(
      "bulk export",
    );
    expect(await page.locator("#progress").textContent()).toBe("4 total · 4 succeeded");
    expect(await page.locator(".identity-path").textContent()).toContain("Variant 1 of 4");
    expect(
      await page
        .locator(".candidate-grid")
        .evaluate(
          (grid) =>
            grid.scrollWidth === grid.clientWidth && getComputedStyle(grid).overflowX !== "auto",
        ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
    expect(
      new Set(
        await page
          .locator(".candidate")
          .evaluateAll((candidates) =>
            candidates.map((candidate) => Math.round(candidate.getBoundingClientRect().top)),
          ),
      ).size,
    ).toBe(1);

    await page.setViewportSize({ width: 1100, height: 900 });
    const compactRects = await page.locator(".candidate").evaluateAll((candidates) =>
      candidates.map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return { top: Math.round(rect.top), width: Math.round(rect.width) };
      }),
    );
    expect(new Set(compactRects.map(({ top }) => top)).size).toBe(2);
    expect(new Set(compactRects.map(({ width }) => width)).size).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await page.click("#history-toggle");
    expect(await page.locator("#history-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("#history-toggle").getAttribute("title")).toBe("Hide history");
    expect(await page.locator(".history-item").getAttribute("aria-current")).toBe("true");
    const drawerStyle = await page.locator("#history-drawer").evaluate((drawer) => ({
      maxHeight: Number.parseFloat(getComputedStyle(drawer).maxHeight),
      overflowY: getComputedStyle(drawer).overflowY,
    }));
    expect(drawerStyle).toEqual({
      maxHeight: await page.evaluate(() => innerHeight - 96),
      overflowY: "auto",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      new Set(
        await page
          .locator(".candidate")
          .evaluateAll((candidates) =>
            candidates.map((candidate) => Math.round(candidate.getBoundingClientRect().top)),
          ),
      ).size,
    ).toBe(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }, 30_000);

  test("keeps desktop candidate sheets on four equal tracks", async () => {
    const { page } = await openWorkbench({}, { width: 1600, height: 1000 });

    for (const variants of [1, 4, 8]) {
      if (variants !== 1) await page.click("#edit-setup");
      await generate(page, `Desktop sheet with ${variants} candidates.`, variants);
      const grid = page.locator(".candidate-grid");
      const tracks = await grid.evaluate((element) =>
        getComputedStyle(element).gridTemplateColumns.split(" ").map(Number.parseFloat),
      );
      expect(tracks).toHaveLength(4);
      expect(new Set(tracks.map(Math.round)).size).toBe(1);

      const rows = await page
        .locator(".candidate")
        .evaluateAll((candidates) =>
          candidates.map((candidate) => Math.round(candidate.getBoundingClientRect().top)),
        );
      expect(new Set(rows).size).toBe(Math.ceil(variants / 4));
    }
  }, 30_000);

  test("uses instant result and setup scrolling when reduced motion is requested", async () => {
    const { page } = await openWorkbench();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => {
      const trackedWindow = window as typeof window & {
        scrollEvents: Array<{ behavior?: ScrollBehavior; id: string }>;
      };
      trackedWindow.scrollEvents = [];
      Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
        trackedWindow.scrollEvents.push({
          behavior: typeof options === "object" ? options.behavior : undefined,
          id: this.id,
        });
      };
    });

    await generate(page, "Reduced-motion scrolling.", 1);
    await page.click("#edit-setup");
    const events = await page.evaluate(
      () =>
        (
          window as typeof window & {
            scrollEvents: Array<{ behavior?: ScrollBehavior; id: string }>;
          }
        ).scrollEvents,
    );
    expect(events.some((event) => event.id === "session-view" && event.behavior === "auto")).toBe(
      true,
    );
    expect(
      events.some((event) => event.id === "generation-form" && event.behavior === "auto"),
    ).toBe(true);
  }, 30_000);

  test("keeps Primary independent from individual and multi-candidate exports", async () => {
    const { page } = await openWorkbench({}, { width: 1600, height: 1000 });
    await generate(page, "Independent export test.", 3);

    await page.locator('[data-focus-candidate="candidate-1-2"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-primary") === "candidate-1-2",
    );
    expect(
      await page
        .locator('[data-primary="candidate-1-2"]')
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Primary updated"),
    );
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-clear-primary"));
    expect(
      await page
        .locator("[data-clear-primary]")
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Primary");

    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Primary cleared"),
    );
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("data-primary") === "candidate-1-2",
    );
    expect(
      await page
        .locator('[data-primary="candidate-1-2"]')
        .evaluate((element) => document.activeElement === element),
    ).toBe(true);
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).not.toContain("Primary");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-clear-primary]");

    await page.locator('[data-export-select="candidate-1-1"]').check();
    await page.locator('[data-export-select="candidate-1-3"]').check();
    expect(await page.locator("[data-export-selected]").textContent()).toBe("Export selected (2)");

    await page.locator('[data-export="candidate-1-2"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("checklist unchanged"),
    );
    expect(await page.locator('[data-export-select="candidate-1-1"]').isChecked()).toBe(true);
    expect(await page.locator('[data-export-select="candidate-1-3"]').isChecked()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-export"))).toBe(
      "candidate-1-2",
    );
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Primary");
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Exported");

    for (const width of [1600, 1100]) {
      await page.setViewportSize({ width, height: 1000 });
      const previews = await page
        .locator(
          '[data-candidate="candidate-1-1"] .candidate-focus, [data-candidate="candidate-1-2"] .candidate-focus',
        )
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              height: Math.round(rect.height),
              top: Math.round(rect.top),
              width: Math.round(rect.width),
            };
          }),
        );
      expect(previews[0]).toEqual(previews[1]);
    }
    await page.setViewportSize({ width: 1600, height: 1000 });

    const exportedCandidateIds: string[] = [];
    const collectExports = (request: Request) => {
      if (request.url().endsWith("/export")) {
        exportedCandidateIds.push((request.postDataJSON() as { candidateId: string }).candidateId);
      }
    };
    page.on("request", collectExports);
    await page.locator("[data-export-selected]").click();
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Exported all 2"),
    );
    page.off("request", collectExports);
    expect(exportedCandidateIds).toEqual(["candidate-1-1", "candidate-1-3"]);
    expect(
      await page.evaluate(() => document.activeElement?.hasAttribute("data-export-selected")),
    ).toBe(true);
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Primary");
    expect(await page.locator("[data-export-record]").count()).toBe(3);
    const history = await page.locator("[data-export-record]").allTextContents();
    expect(history.every((record) => record.includes("Independent export test."))).toBe(true);
    expect(history.every((record) => record.includes("Exported"))).toBe(true);
    expect(history.join(" ")).not.toMatch(/raw\.svg|production\.png|manifest\.json|\/sessions\//);
  }, 30_000);

  test("reports partial bulk-export failure and preserves the exact checklist", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Partial export feedback.", 2);
    await page.locator('[data-export-select="candidate-1-1"]').check();
    await page.locator('[data-export-select="candidate-1-2"]').check();

    const requested: string[] = [];
    await page.route("**/export", async (route, request) => {
      const candidateId = (request.postDataJSON() as { candidateId: string }).candidateId;
      requested.push(candidateId);
      if (candidateId === "candidate-1-2") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Deliberate export failure" } }),
        });
      }
      await route.continue();
    });
    await page.locator("[data-export-selected]").click();
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Exported 1 of 2"),
    );
    await page.unroute("**/export");
    expect(requested).toEqual(["candidate-1-1", "candidate-1-2"]);
    expect(await page.locator("#session-message").textContent()).toContain(
      "1 failed: Folio geometric isometric → Partial export feedback. → Variant 2 of 2: Deliberate export failure",
    );
    expect(await page.locator('[data-export-select="candidate-1-1"]').isChecked()).toBe(true);
    expect(await page.locator('[data-export-select="candidate-1-2"]').isChecked()).toBe(true);
  }, 30_000);

  test("preserves local focus, export selection, and open recipe details across polling", async () => {
    let failSecond!: () => void;
    const second = new Promise<void>((resolve) => {
      failSecond = resolve;
    });
    const { instance, page } = await openWorkbench({
      mock: false,
      runner: async () => {
        await second;
        throw new Error("deliberate second-variant failure");
      },
    });
    await page.route("**/candidates/*/images/0", (route) =>
      route.fulfill({ contentType: "image/png", body: Buffer.from(pngBytes()) }),
    );

    await page.fill("#subject", "Polling stability test.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "2");
    await page.click("#generate-button");
    await page.waitForSelector(
      '[data-candidate="candidate-1-1"] .candidate-label span:text-is("Running")',
    );
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-label span:text-is("Running")',
    );
    await instance.store.updateSession((await instance.store.listHistory())[0].id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "succeeded";
      candidate.completedAt = new Date().toISOString();
      candidate.images = [
        {
          path: "polling-fixture.png",
          mimeType: "image/png",
          bytes: pngBytes().length,
          width: 1,
          height: 1,
          sha256: "polling-fixture",
        },
      ];
    });
    await page.waitForSelector('[data-candidate="candidate-1-1"] img');
    await page.locator('[data-export-select="candidate-1-1"]').check();
    await page.locator('[data-focus-candidate="candidate-1-2"]').click();
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("data-focus-candidate")),
    ).toBe("candidate-1-2");
    await page.locator(".arm-prompt summary").click();
    await page.click("#edit-setup");
    await page.fill("#subject", "Draft preserved during polling.");
    await page.locator('[data-focus-candidate="candidate-1-2"]').focus();
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);

    let failedPoll = false;
    await page.route("**/api/sessions/*", async (route, request) => {
      if (
        request.method() === "GET" &&
        /\/api\/sessions\/[^/]+$/.test(request.url()) &&
        !failedPoll
      ) {
        failedPoll = true;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Transient poll failure" } }),
        });
      }
      await route.continue();
    });
    await page.waitForFunction(() =>
      document.querySelector("#session-message")?.textContent?.includes("Transient poll failure"),
    );
    await page.unroute("**/api/sessions/*");

    failSecond();
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-label span:text-is("Failed")',
    );
    await page.unroute("**/candidates/*/images/0");
    expect(await page.locator("#session-message").textContent()).not.toContain(
      "Transient poll failure",
    );
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("data-focus-candidate")),
    ).toBe("candidate-1-2");
    expect(await page.locator('[data-export-select="candidate-1-1"]').isChecked()).toBe(true);
    expect(
      await page.locator('[data-focus-candidate="candidate-1-2"]').getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await page.locator(".identity-path").textContent()).toContain("Variant 2 of 2");
    expect(await page.locator(".arm-prompt").getAttribute("open")).not.toBeNull();
    expect(await page.locator("[data-export-selected]").textContent()).toBe("Export selected (1)");
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
    expect(await page.locator("#subject").inputValue()).toBe("Draft preserved during polling.");
    expect(await page.locator("#candidate-inspector").textContent()).toContain(
      "This candidate could not be generated",
    );
    expect(await page.locator("#candidate-inspector").textContent()).not.toContain(
      "deliberate second-variant failure",
    );
    expect(
      await page
        .locator('[data-candidate="candidate-1-2"] .failed-placeholder')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    const stored = await instance.store.readSession((await instance.store.listHistory())[0].id);
    expect(stored.arms[0].candidates[1].error).toContain("deliberate second-variant failure");
  }, 30_000);

  test("does not re-announce unchanged progress during polling", async () => {
    const { page } = await openWorkbench({
      mock: false,
      runner: () => new Promise(() => {}),
    });
    await page.fill("#subject", "Stable progress announcement.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Running")');
    await page.evaluate(() => {
      const trackedWindow = window as typeof window & { progressMutations: number };
      trackedWindow.progressMutations = 0;
      const progress = document.querySelector("#progress");
      if (!progress) throw new Error("Progress region was not found.");
      new MutationObserver((mutations) => {
        trackedWindow.progressMutations += mutations.length;
      }).observe(progress, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    });
    await page.waitForTimeout(1200);
    expect(
      await page.evaluate(
        () => (window as typeof window & { progressMutations: number }).progressMutations,
      ),
    ).toBe(0);
  }, 30_000);

  test("renders interrupted and cancellation-requested candidates as static while polling by run status", async () => {
    const { instance, page } = await openWorkbench({
      mock: false,
      runner: () => new Promise(() => {}),
    });
    await page.fill("#subject", "Terminal candidate states.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "2");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Running")');
    const sessionId = (await instance.store.listHistory())[0].id;
    let pollCount = 0;
    page.on("request", (request) => {
      if (request.method() === "GET" && request.url().endsWith(`/api/sessions/${sessionId}`)) {
        pollCount++;
      }
    });
    await instance.store.updateSession(sessionId, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "cancel-requested";
      candidate.error = "Generation stopped locally after cancellation was requested.";
      candidate.cancellation = {
        requestedAt: new Date().toISOString(),
        billing: "unknown-may-be-charged",
      };
    });
    await page.waitForSelector(
      '[data-candidate="candidate-1-1"] .candidate-label span:text-is("Cancellation requested")',
    );
    expect(
      await page.locator('[data-candidate="candidate-1-1"] .terminal-placeholder').textContent(),
    ).toContain("Cancellation requested");
    expect(
      await page
        .locator('[data-candidate="candidate-1-1"] .terminal-placeholder')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await page.click("#theme-toggle");
    await page.waitForFunction(() =>
      document
        .querySelector("#candidate-inspector")
        ?.textContent?.includes("Generation stopped on this workbench"),
    );
    expect(await page.locator("#candidate-inspector").textContent()).not.toContain("provider");
    const activePollCount = pollCount;
    await page.waitForTimeout(1100);
    expect(pollCount).toBeGreaterThan(activePollCount);

    await instance.store.updateSession(sessionId, (manifest) => {
      const candidate = manifest.arms[0].candidates[1];
      candidate.status = "interrupted";
      candidate.completedAt = new Date().toISOString();
      candidate.error = "Workbench stopped before this call completed.";
    });
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-label span:text-is("Interrupted")',
    );
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .terminal-placeholder').textContent(),
    ).toContain("Generation interrupted");
    expect(
      await page
        .locator('[data-candidate="candidate-1-2"] .terminal-placeholder')
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    await page.locator('[data-focus-candidate="candidate-1-2"]').click();
    expect(await page.locator("#candidate-inspector").textContent()).toContain(
      "The workbench stopped before this call completed",
    );
    expect(await page.locator("#candidate-inspector").textContent()).not.toContain("provider");
    expect(
      await elementContrast(page, "#candidate-inspector .terminal-placeholder"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(await page.locator("#candidate-inspector [data-terminal-recovery]").count()).toBe(1);
    expect(await page.locator("#candidate-inspector [data-terminal-recovery]").textContent()).toBe(
      "Edit setup and retry",
    );
    expect(await page.locator("#candidate-inspector h3").allTextContents()).toEqual([
      "Status and cost",
    ]);
    expect(
      await page.locator("#candidate-inspector .inspector-fact dd").first().textContent(),
    ).toBe("Interrupted");
    expect(await page.locator("#cancel").isHidden()).toBe(true);
    expect(await page.locator("#regenerate").textContent()).toBe("Edit and regenerate");
    await page.waitForFunction(() =>
      document.querySelector(".history-item small")?.textContent?.startsWith("Interrupted"),
    );
    const terminalPollCount = pollCount;
    await page.waitForTimeout(1200);
    expect(pollCount).toBe(terminalPollCount);
    await page.locator("[data-terminal-recovery]").focus();
    await page.keyboard.press("Enter");
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
    expect(
      await page.locator("#subject").evaluate((element) => document.activeElement === element),
    ).toBe(true);
  }, 30_000);

  test("shows concise recovery copy for raw provider failures", async () => {
    const raw =
      '{"error":{"code":429,"message":"RESOURCE_EXHAUSTED at https://provider.example/internal/request/123"}}';
    const { instance, page } = await openWorkbench({
      mock: false,
      runner: async () => {
        throw new Error(raw);
      },
    });
    await page.fill("#subject", "Provider failure copy.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Failed")');

    const visible = await page.locator("#session-view").textContent();
    expect(visible).toContain("The provider rate limit was reached");
    expect(visible).not.toContain("provider.example");
    expect(visible).not.toContain('"error"');
    expect(await page.locator(".candidate-message").count()).toBe(1);
    expect(await page.locator(".failed-placeholder").count()).toBe(2);
    expect(
      await page
        .locator(".failed-placeholder")
        .first()
        .evaluate((element) => getComputedStyle(element).animationName),
    ).toBe("none");
    expect(await page.locator("[data-focus-candidate]").count()).toBe(1);
    expect(await page.locator("[data-retry]").count()).toBe(0);
    expect(await page.locator("[data-terminal-recovery]").count()).toBe(1);
    expect(await page.locator("[data-terminal-recovery]").textContent()).toBe(
      "Edit setup and retry",
    );
    expect(await page.locator("#candidate-inspector h3").allTextContents()).toEqual([
      "Status and cost",
    ]);
    expect(
      await page.locator("#candidate-inspector .inspector-fact dd").first().textContent(),
    ).toBe("Failed");
    expect(await page.locator("#regenerate").isEnabled()).toBe(true);
    expect(await page.locator("#regenerate").textContent()).toBe("Edit and regenerate");
    expect(await page.locator("#cancel").isHidden()).toBe(true);
    await page.click("#theme-toggle");
    expect(
      await elementContrast(page, "#candidate-inspector .failed-placeholder"),
    ).toBeGreaterThanOrEqual(4.5);

    const session = await instance.store.readSession((await instance.store.listHistory())[0].id);
    expect(session.arms[0].candidates[0].error).toContain("provider.example");
    await page.locator("[data-terminal-recovery]").focus();
    await page.keyboard.press("Enter");
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
    expect(
      await page.locator("#subject").evaluate((element) => document.activeElement === element),
    ).toBe(true);
  }, 30_000);

  test("keeps a successful run visible when its history refresh fails", async () => {
    const { page } = await openWorkbench();
    await page.route("**/api/history", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "History refresh failed" } }),
      }),
    );
    await generate(page, "Successful run with unavailable history.", 1);
    expect(await page.locator("#session-view").isVisible()).toBe(true);
    expect(await page.locator("#session-title").textContent()).toBe(
      "Successful run with unavailable history.",
    );
    expect(await page.locator("#form-error").textContent()).toBe("");
    await page.click("#history-toggle");
    expect(await page.locator("#history-list").textContent()).toContain("History refresh failed");
    await page.unroute("**/api/history");
  }, 30_000);

  test("keeps the latest manual session and history intent", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Earlier manual choice.", 1);
    await page.click("#edit-setup");
    await generate(page, "Later manual choice.", 1);
    await page.click("#history-toggle");
    const earlier = page.locator('.history-item:has-text("Earlier manual choice.")');
    const later = page.locator('.history-item:has-text("Later manual choice.")');
    const earlierId = await earlier.getAttribute("data-session");
    expect(earlierId).toBeTruthy();

    let releaseEarlier!: () => void;
    const earlierPaused = new Promise<void>((resolve) => {
      releaseEarlier = resolve;
    });
    await page.route(`**/api/sessions/${earlierId}`, async (route) => {
      await earlierPaused;
      await route.continue();
    });
    await earlier.click();
    await later.click();
    await page.waitForFunction(
      () => document.querySelector("#session-title")?.textContent === "Later manual choice.",
    );
    releaseEarlier();
    await page.waitForTimeout(250);
    expect(await page.locator("#session-title").textContent()).toBe("Later manual choice.");
    await page.unroute(`**/api/sessions/${earlierId}`);

    let historyRequest = 0;
    let releaseOldHistory!: () => void;
    const oldHistoryPaused = new Promise<void>((resolve) => {
      releaseOldHistory = resolve;
    });
    await page.route("**/api/history", async (route) => {
      historyRequest++;
      if (historyRequest === 1) {
        await oldHistoryPaused;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Stale history failure" } }),
        });
      }
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ sessions: [] }),
      });
    });
    await page.click("#history-refresh");
    await page.click("#history-refresh");
    await page.waitForFunction(() =>
      document.querySelector("#history-list")?.textContent?.includes("No workbench sessions yet"),
    );
    releaseOldHistory();
    await page.waitForTimeout(250);
    expect(await page.locator(".history-item").count()).toBe(0);
    expect(await page.locator("#history-list").textContent()).not.toContain(
      "Stale history failure",
    );
    await page.unroute("**/api/history");
  }, 30_000);

  test("ignores stale generation and cancellation failures after switching sessions", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Stable session A.", 1);
    await page.click("#edit-setup");
    await generate(page, "Stable session B.", 1);
    await page.click("#edit-setup");

    let releaseGeneration!: () => void;
    const generationPaused = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    let confirmGenerationPaused!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      confirmGenerationPaused = resolve;
    });
    await page.route("**/api/sessions", async (route, request) => {
      if (request.method() !== "POST") return route.continue();
      confirmGenerationPaused();
      await generationPaused;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Stale generation failure" } }),
      });
    });
    await page.fill("#subject", "Superseded generation.");
    await page.click("#generate-button");
    await generationStarted;
    await page.click("#history-toggle");
    const sessionA = page.locator('.history-item:has-text("Stable session A.")');
    const sessionB = page.locator('.history-item:has-text("Stable session B.")');
    await sessionA.click();
    await page.waitForFunction(
      () => document.querySelector("#session-title")?.textContent === "Stable session A.",
    );
    releaseGeneration();
    await page.waitForTimeout(250);
    expect(await page.locator("#session-view").isVisible()).toBe(true);
    expect(await page.locator("#session-title").textContent()).toBe("Stable session A.");
    expect(await page.locator("#form-error").textContent()).not.toContain(
      "Stale generation failure",
    );
    expect(await page.locator("#generate-button").textContent()).toBe("Generate");
    await page.unroute("**/api/sessions");

    let releaseCancellation!: () => void;
    const cancellationPaused = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let confirmCancellationPaused!: () => void;
    const cancellationStarted = new Promise<void>((resolve) => {
      confirmCancellationPaused = resolve;
    });
    await page.route("**/api/sessions/*/cancel", async (route) => {
      confirmCancellationPaused();
      await cancellationPaused;
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Stale cancellation failure" } }),
      });
    });
    await page.locator("#cancel").evaluate((button: HTMLButtonElement) => {
      button.hidden = false;
      button.disabled = false;
    });
    await page.click("#cancel");
    await cancellationStarted;
    await sessionB.click();
    await page.waitForFunction(
      () => document.querySelector("#session-title")?.textContent === "Stable session B.",
    );
    releaseCancellation();
    await page.waitForTimeout(250);
    expect(await page.locator("#session-title").textContent()).toBe("Stable session B.");
    expect(await page.locator("#session-message").textContent()).not.toContain(
      "Stale cancellation failure",
    );
    await page.unroute("**/api/sessions/*/cancel");
  }, 30_000);

  test("splits long titles safely with and without Intl.Segmenter", async () => {
    const { page } = await openWorkbench();
    const family = "👩‍👩‍👧‍👦";
    const subject = `${"a".repeat(89)}${family} tail`;
    await generate(page, subject, 1);
    const title = (await page.locator("#session-title").textContent()) ?? "";
    const subtitle = (await page.locator("#session-subtitle").textContent()) ?? "";
    expect(title.endsWith(family)).toBe(true);
    expect(`${title} ${subtitle}`).toBe(subject);

    const fallback = await openWorkbench(
      {},
      { width: 1440, height: 1000 },
      "Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true });",
    );
    const combining = "e\u0301";
    const fallbackSubject = `${"b".repeat(89)}${family}${combining} tail`;
    await generate(fallback.page, fallbackSubject, 1);
    const fallbackTitle = (await fallback.page.locator("#session-title").textContent()) ?? "";
    expect(fallbackTitle).toBe(fallbackSubject);
    expect(await fallback.page.locator("#session-subtitle").isHidden()).toBe(true);
  }, 30_000);

  test("keeps a paused bulk export scoped to its original session", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Export race A.", 2);
    await page.click("#edit-setup");
    await generate(page, "Export race B.", 1);
    await page.click("#history-toggle");

    const sessionA = page.locator('.history-item:has-text("Export race A.")');
    const sessionB = page.locator('.history-item:has-text("Export race B.")');
    const sessionAId = await sessionA.getAttribute("data-session");
    expect(sessionAId).toBeTruthy();
    if (!sessionAId) throw new Error("Export race session was not found.");
    await sessionA.click();
    await page.waitForFunction(
      () => document.querySelector("#session-title")?.textContent === "Export race A.",
    );
    await page.click("#edit-setup");
    expect(await page.locator("#subject").inputValue()).toBe("Export race A.");
    expect(await page.locator("#variants").inputValue()).toBe("2");
    await page.locator('[data-export-select="candidate-1-1"]').check();
    await page.locator('[data-export-select="candidate-1-2"]').check();

    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let confirmPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      confirmPaused = resolve;
    });
    const requestSessionIds: string[] = [];
    let confirmSecondRequest!: () => void;
    const secondRequest = new Promise<void>((resolve) => {
      confirmSecondRequest = resolve;
    });
    const collectExportSessions = (request: Request) => {
      if (!request.url().endsWith("/export")) return;
      const parts = new URL(request.url()).pathname.split("/");
      requestSessionIds.push(parts.at(-2) ?? "");
      if (requestSessionIds.length === 2) confirmSecondRequest();
    };
    page.on("request", collectExportSessions);
    let pausedFirst = false;
    await page.route("**/api/sessions/*/export", async (route) => {
      if (!pausedFirst) {
        pausedFirst = true;
        confirmPaused();
        await firstPaused;
      }
      await route.continue();
    });

    await page.locator("[data-export-selected]").click();
    await paused;
    await sessionB.click();
    await page.waitForFunction(
      () => document.querySelector("#session-title")?.textContent === "Export race B.",
    );
    releaseFirst();
    await page.waitForFunction(async (id) => {
      const response = await fetch(`/api/sessions/${id}`);
      const body = await response.json();
      return body.session.exports.length === 2;
    }, sessionAId);
    await secondRequest;
    await page.unroute("**/api/sessions/*/export");
    page.off("request", collectExportSessions);
    expect(requestSessionIds).toEqual([sessionAId, sessionAId]);
    expect(await page.locator("#session-title").textContent()).toBe("Export race B.");
    expect(await page.locator("#session-message").textContent()).not.toContain("Exported all 2");
    await page.waitForFunction(
      () => !document.querySelector("[data-export]")?.hasAttribute("aria-disabled"),
    );
    expect(await page.locator("[data-export]").isEnabled()).toBe(true);
  }, 30_000);

  test("reuses and revokes reference preview URLs", async () => {
    const { page } = await openWorkbench();
    await page.locator(".setup-details summary").click();
    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      const revoke = URL.revokeObjectURL.bind(URL);
      const trackedWindow = window as typeof window & {
        previewUrlEvents: { created: number; revoked: number };
      };
      trackedWindow.previewUrlEvents = { created: 0, revoked: 0 };
      URL.createObjectURL = (file) => {
        trackedWindow.previewUrlEvents.created++;
        return create(file);
      };
      URL.revokeObjectURL = (url) => {
        trackedWindow.previewUrlEvents.revoked++;
        revoke(url);
      };
    });
    await page.setInputFiles("#references", [
      { name: "one.png", mimeType: "image/png", buffer: Buffer.from(pngBytes()) },
      { name: "two.png", mimeType: "image/png", buffer: Buffer.from(pngBytes()) },
    ]);
    await page.locator('[data-ref-down="0"]').click();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              previewUrlEvents: { created: number; revoked: number };
            }
          ).previewUrlEvents.created,
      ),
    ).toBe(2);
    await page.locator('[data-ref-remove="0"]').click();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              previewUrlEvents: { created: number; revoked: number };
            }
          ).previewUrlEvents.revoked,
      ),
    ).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("beforeunload")));
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              previewUrlEvents: { created: number; revoked: number };
            }
          ).previewUrlEvents.revoked,
      ),
    ).toBe(2);
  });

  test("aggregates truthful spend and generated image counts across stored runs", async () => {
    const { page } = await openWorkbench();
    const base = {
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      status: "completed",
      recipes: ["Folio geometric isometric"],
      settings: { modelId: "gemini-3.1-flash-image", callCount: 99 },
    };
    let sessions: unknown[] = [
      {
        ...base,
        id: "complete",
        subject: "Complete spend",
        generatedImageCount: 1,
        spend: {
          status: "complete",
          calculatedUsd: 0.1,
          calculatedCount: 1,
          upperBoundCount: 0,
          unavailableCount: 0,
          unknownMayBeChargedCount: 0,
          unknownGroundingChargeCount: 0,
        },
      },
      {
        ...base,
        id: "upper",
        subject: "Upper-bound spend",
        generatedImageCount: 2,
        settings: { modelId: "gemini-3-pro-image", callCount: 99 },
        spend: {
          status: "upper-bound",
          upperBoundUsd: 0.2,
          calculatedCount: 0,
          upperBoundCount: 2,
          unavailableCount: 0,
          unknownMayBeChargedCount: 0,
          unknownGroundingChargeCount: 0,
        },
      },
      {
        ...base,
        id: "partial",
        subject: "Partial spend",
        generatedImageCount: 1,
        spend: {
          status: "partial",
          calculatedUsd: 0.05,
          calculatedCount: 1,
          upperBoundCount: 0,
          unavailableCount: 0,
          unknownMayBeChargedCount: 1,
          unknownGroundingChargeCount: 1,
        },
      },
    ];
    await page.route("**/api/history", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) }),
    );
    await page.click("#history-toggle");
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "Partial · $0.15 + up to $0.20",
    );
    expect(await page.locator("#spend-total").textContent()).toBe("Partial · $0.15 + up to $0.20");
    await page.click("#spend-toggle");
    expect(await page.locator("#spend-breakdown").textContent()).toContain(
      "Across all 3 stored runs",
    );
    expect(await page.locator(".spend-row .muted").allTextContents()).toEqual([
      "2 generated images",
      "2 generated images",
    ]);
    expect(await page.locator("#spend-breakdown").textContent()).not.toContain("99 images");
    expect(
      await page
        .locator(".spend-row")
        .filter({ hasText: "Gemini 3.1 Flash Image" })
        .locator("strong")
        .textContent(),
    ).toBe("Known: $0.15");
    expect(
      await page
        .locator(".spend-row")
        .filter({ hasText: "Gemini 3.1 Flash Image" })
        .locator(".spend-caveat")
        .textContent(),
    ).toContain("may have been charged");
    expect(await page.locator("#spend-breakdown").textContent()).toContain(
      "Grounding charges are not included for 1 candidate request",
    );
    expect(
      await page
        .locator(".spend-row")
        .filter({ hasText: "Gemini 3 Pro Image" })
        .locator("strong")
        .textContent(),
    ).toBe("up to $0.20");

    sessions = [
      {
        ...base,
        id: "not-submitted",
        subject: "Canceled before submission",
        generatedImageCount: 0,
        spend: {
          status: "complete",
          calculatedCount: 0,
          upperBoundCount: 0,
          unavailableCount: 0,
          unknownMayBeChargedCount: 0,
          unknownGroundingChargeCount: 0,
        },
      },
    ];
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "$0.00",
    );
    expect(await page.locator("#spend-total").textContent()).toBe("$0.00");
    expect(await page.locator("#spend-breakdown").textContent()).toContain("0 generated images");
    expect(await page.locator("#spend-breakdown strong").textContent()).toBe("$0.00");

    sessions = [
      {
        ...base,
        id: "unavailable",
        subject: "Unavailable spend",
        generatedImageCount: 0,
        spend: {
          status: "unavailable",
          calculatedCount: 0,
          upperBoundCount: 0,
          unavailableCount: 1,
          unknownMayBeChargedCount: 0,
          unknownGroundingChargeCount: 0,
        },
      },
    ];
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "Cost unavailable",
    );
    expect(await page.locator("#spend-total").textContent()).toBe("Cost unavailable");
    expect(await page.locator("#spend-total").textContent()).not.toBe("$0.00");

    sessions = [
      {
        ...base,
        id: "may-charge",
        subject: "Unknown cancellation charge",
        generatedImageCount: 0,
        spend: {
          status: "unavailable",
          calculatedCount: 0,
          upperBoundCount: 0,
          unavailableCount: 0,
          unknownMayBeChargedCount: 1,
          unknownGroundingChargeCount: 0,
        },
      },
    ];
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "May have charges",
    );
    expect(await page.locator("#spend-total").textContent()).not.toBe("Cost unavailable");
    await page.unroute("**/api/history");
  });

  test("keeps cancellation warning visible and de-emphasizes disabled cancellation", async () => {
    const { page } = await openWorkbench({
      mock: false,
      runner: (request) =>
        new Promise((_resolve, reject) => {
          request.abortSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    await page.fill("#subject", "Cancellation warning test.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Running")');
    await page.click("#cancel");
    await page.waitForSelector('.candidate-label span:text-is("Cancellation requested")');
    expect(await page.locator(".candidate-message").first().textContent()).toContain(
      "billing may still occur",
    );
    expect(await page.locator("#candidate-inspector").textContent()).toContain(
      "Unknown; may have been charged",
    );
    expect(await page.locator("#cancel").isHidden()).toBe(true);
  }, 30_000);

  test("disables project-icon export when provider output is not square", async () => {
    const { page } = await openWorkbench({
      mock: false,
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
    await generate(page, "Non-square export guard.", 1);
    expect(await page.locator("[data-export]").isDisabled()).toBe(true);
    expect(await page.locator("[data-export-select]").isDisabled()).toBe(true);
    expect(await page.locator(".candidate-message").first().textContent()).toContain(
      "project icons require a square generated image",
    );
  }, 30_000);

  test("disables generation and shows exact setup guidance when the key is missing", async () => {
    const previous = process.env.NANO_BANANA_TEST_NO_API_KEY;
    process.env.NANO_BANANA_TEST_NO_API_KEY = "1";
    let opened: Awaited<ReturnType<typeof openWorkbench>>;
    try {
      opened = await openWorkbench({ mock: false });
    } finally {
      if (previous === undefined) delete process.env.NANO_BANANA_TEST_NO_API_KEY;
      else process.env.NANO_BANANA_TEST_NO_API_KEY = previous;
    }
    const { page } = opened;
    expect(await page.locator("#generate-button").isDisabled()).toBe(true);
    expect(await page.locator("#key-status").textContent()).toBe("API key not configured");
    const guidance = await page.locator("#key-guidance").textContent();
    expect(guidance).toContain("GEMINI_API_KEY");
    expect(guidance).toContain("~/.nano-banana/.env");
    expect(guidance).toContain("restart");
  });

  test("clears unreadable history through a count-agnostic recovery", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Corrupt history recovery.", 1);
    await page.click("#history-toggle");
    let cleared = false;
    await page.route("**/api/history", async (route, request) => {
      if (request.method() === "DELETE") {
        cleared = true;
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ cleared: 1 }),
        });
      }
      if (cleared) {
        return route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({ sessions: [] }),
        });
      }
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "history_read_failed", message: "Stored history could not be read." },
        }),
      });
    });
    await page.click("#history-refresh");
    await page.waitForFunction(() =>
      document.querySelector("#history-list")?.textContent?.includes("history is unavailable"),
    );
    expect(await page.locator("#history-clear").textContent()).toBe("Clear all history");
    expect(await page.locator("#history-clear").isEnabled()).toBe(true);

    let confirmation = "";
    page.on("dialog", async (dialog) => {
      confirmation = dialog.message();
      await dialog.accept();
    });
    await page.click("#history-clear");
    await page.waitForFunction(() =>
      document
        .querySelector("#history-clear-status")
        ?.textContent?.includes("Cleared 1 stored run"),
    );
    expect(confirmation).toContain("delete all stored runs");
    expect(confirmation).not.toMatch(/delete \d+ stored/);
    expect(await page.locator("#history-list").textContent()).toContain(
      "No workbench sessions yet.",
    );
    expect(
      await page.locator("#subject").evaluate((element) => document.activeElement === element),
    ).toBe(true);
    expect(await page.locator("#generate-button").isEnabled()).toBe(true);
    await page.unroute("**/api/history");
  }, 30_000);

  test("clears all stored history and resets the workbench to a fresh setup form", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Clearable run.", 2);
    await page.click("#history-toggle");
    expect(await page.locator(".history-item").count()).toBe(1);
    expect(await page.locator("#history-clear").isDisabled()).toBe(false);
    expect(await page.locator("#spend-toggle").isHidden()).toBe(false);
    expect(await page.locator("#session-view").isHidden()).toBe(false);

    page.on("dialog", (dialog) => dialog.accept());
    await page.click("#history-clear");
    await page.waitForFunction(() =>
      document
        .querySelector("#history-clear-status")
        ?.textContent?.includes("Cleared 1 stored run"),
    );

    expect(await page.locator("#history-list").textContent()).toContain(
      "No workbench sessions yet.",
    );
    expect(await page.locator(".history-item").count()).toBe(0);
    expect(await page.locator("#session-view").isHidden()).toBe(true);
    expect(await page.locator("#candidate-groups").textContent()).toBe("");
    expect(await page.locator("#spend-toggle").isHidden()).toBe(true);
    expect(await page.locator("#history-clear").isDisabled()).toBe(true);
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
    expect(await page.locator("#run-summary").isHidden()).toBe(true);
  }, 30_000);

  test("dismisses the Clear history confirm and keeps every session", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Keep this run.", 1);
    await page.click("#history-toggle");
    let deleteRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "DELETE" && request.url().endsWith("/api/history")) deleteRequests++;
    });
    page.on("dialog", (dialog) => dialog.dismiss());
    await page.click("#history-clear");
    await page.waitForTimeout(200);
    expect(deleteRequests).toBe(0);
    expect(await page.locator(".history-item").count()).toBe(1);
    expect(await page.locator("#session-view").isHidden()).toBe(false);
    expect(await page.locator("#history-clear-status").textContent()).toBe("");
    expect(await page.locator("#history-clear").isDisabled()).toBe(false);
  }, 30_000);

  test("discards an in-flight session load that resolves after a clear", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Racy refresh.", 1);
    await page.click("#history-toggle");

    let releaseGet!: () => void;
    const pausedGet = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    let paused = false;
    await page.route(/\/api\/sessions\/[^/]+$/, async (route, request) => {
      if (request.method() === "GET" && !paused) {
        paused = true;
        await pausedGet;
      }
      return route.continue();
    });
    // Click the stored run: refreshSession fires and hangs on the paused GET.
    await page.locator(".history-item").click();

    page.on("dialog", (dialog) => dialog.accept());
    await page.click("#history-clear");
    await page.waitForFunction(() =>
      document.querySelector("#history-clear-status")?.textContent?.includes("Cleared"),
    );
    expect(await page.locator("#session-view").isHidden()).toBe(true);

    // The stale GET now resolves; the epoch guard must discard it, not repaint.
    releaseGet();
    await page.waitForTimeout(300);
    expect(await page.locator("#session-view").isHidden()).toBe(true);
    expect(await page.locator("#history-list").textContent()).toContain(
      "No workbench sessions yet.",
    );
    await page.unroute(/\/api\/sessions\/[^/]+$/);
  }, 30_000);

  test("restores history after a failed clear and surfaces the error", async () => {
    const { page } = await openWorkbench();
    await generate(page, "Resilient run.", 1);
    await page.click("#history-toggle");
    let releaseRecovery!: () => void;
    const recoveryPaused = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    let confirmRecoveryStarted!: () => void;
    const recoveryStarted = new Promise<void>((resolve) => {
      confirmRecoveryStarted = resolve;
    });
    let clearFailed = false;
    await page.route("**/api/history", async (route, request) => {
      if (request.method() === "DELETE") {
        clearFailed = true;
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "history_clear_failed", message: "Failed to clear workbench history." },
          }),
        });
      }
      if (request.method() === "GET" && clearFailed) {
        confirmRecoveryStarted();
        await recoveryPaused;
      }
      return route.continue();
    });
    page.on("dialog", (dialog) => dialog.accept());
    await page.click("#history-clear");
    await recoveryStarted;
    expect(await page.locator("#history-clear-status").textContent()).toBe("Clearing history…");
    expect(await page.locator("#history-clear").isDisabled()).toBe(true);
    releaseRecovery();
    await page.waitForFunction(() =>
      document.querySelector("#history-clear-status")?.classList.contains("error"),
    );
    expect(await page.locator("#history-clear-status").textContent()).toContain("Failed to clear");
    expect(await page.locator(".history-item").count()).toBe(1);
    expect(await page.locator("#session-view").isHidden()).toBe(false);
    expect(await page.locator("#history-clear").isDisabled()).toBe(false);
    expect(await page.locator("#history-clear").textContent()).toBe("Clear history");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("history-clear");
    await page.unroute("**/api/history");
  }, 30_000);

  test("stops polling when the current session disappears mid-run", async () => {
    const { page } = await openWorkbench({
      mock: false,
      runner: () => new Promise(() => {}),
    });
    await page.fill("#subject", "Vanishing run.");
    await page.locator(".setup-details").evaluate((details: HTMLDetailsElement) => {
      details.open = true;
    });
    await page.fill("#variants", "1");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Running")');

    let pollCount = 0;
    await page.route("**/api/sessions/*", (route, request) => {
      if (request.method() === "GET" && /\/api\/sessions\/[^/]+$/.test(request.url())) {
        pollCount++;
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "session_not_found", message: "Session not found." },
          }),
        });
      }
      return route.continue();
    });
    await page.waitForFunction(() =>
      document.querySelector("#form-error")?.textContent?.includes("no longer available"),
    );
    await page.waitForTimeout(2000);
    expect(pollCount).toBe(1);
    expect(await page.locator("#candidate-groups").textContent()).toBe("");
    expect(await page.locator("#regenerate").isDisabled()).toBe(true);
    expect(await page.locator("#cancel").isDisabled()).toBe(true);
    expect(await page.locator("#edit-setup").isDisabled()).toBe(true);
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
    expect(await page.locator("#run-summary").isHidden()).toBe(true);
    expect(await page.locator("#generate-button").isEnabled()).toBe(true);
    expect(
      await page.locator("#subject").evaluate((element) => document.activeElement === element),
    ).toBe(true);
    expect(pollCount).toBe(1);
    await page.unroute("**/api/sessions/*");
    await page.fill("#subject", "Replacement run.");
    await page.click("#generate-button");
    await page.waitForSelector('.candidate-label span:text-is("Running")');
    expect(await page.locator("#form-error").textContent()).toBe("");
  }, 30_000);
});
