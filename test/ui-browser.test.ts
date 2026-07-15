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
) {
  const root = await mkdtemp(join(tmpdir(), "nano-banana-browser-test-"));
  cleanup.push(async () => rm(root, { recursive: true, force: true }));
  const instance = await startWorkbench({ port: 0, mock: true, storageRoot: root, ...options });
  cleanup.push(async () => instance.server.stop(true));
  const context: BrowserContext = await browser.newContext({ viewport });
  cleanup.push(async () => context.close());
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

describe("workbench browser contract", () => {
  test("uses a collapsed history rail, accessible candidate identity, and a no-scroll contact sheet", async () => {
    const { page } = await openWorkbench();

    expect(await page.locator("#history-toggle").getAttribute("aria-expanded")).toBe("false");
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

    await page.click("#history-toggle");
    expect(await page.locator("#history-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator(".history-item").getAttribute("aria-current")).toBe("true");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth === document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }, 30_000);

  test("keeps Primary independent from individual and multi-candidate exports", async () => {
    const { page } = await openWorkbench();
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
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Primary");
    expect(
      await page.locator('[data-candidate="candidate-1-2"] .candidate-flags').textContent(),
    ).toContain("Exported");

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
      '[data-candidate="candidate-1-1"] .candidate-label span:text-is("running")',
    );
    await page.waitForSelector(
      '[data-candidate="candidate-1-2"] .candidate-label span:text-is("running")',
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
    await page.locator(".arm-prompt summary").click();
    await page.click("#edit-setup");
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
      '[data-candidate="candidate-1-2"] .candidate-label span:text-is("failed")',
    );
    await page.unroute("**/candidates/*/images/0");
    expect(await page.locator('[data-export-select="candidate-1-1"]').isChecked()).toBe(true);
    expect(
      await page.locator('[data-focus-candidate="candidate-1-2"]').getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await page.locator(".identity-path").textContent()).toContain("Variant 2 of 2");
    expect(await page.locator(".arm-prompt").getAttribute("open")).not.toBeNull();
    expect(await page.locator("[data-export-selected]").textContent()).toBe("Export selected (1)");
    expect(await page.locator(".editor-fields").isVisible()).toBe(true);
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
        },
      },
    ];
    await page.route("**/api/history", (route) =>
      route.fulfill({ contentType: "application/json", body: JSON.stringify({ sessions }) }),
    );
    await page.click("#history-toggle");
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "$0.15 + ≤$0.20 + unknown",
    );
    expect(await page.locator("#spend-total").textContent()).toBe("$0.15 + ≤$0.20 + unknown");
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
    ).toBe("$0.15 + unknown");
    expect(
      await page
        .locator(".spend-row")
        .filter({ hasText: "Gemini 3 Pro Image" })
        .locator("strong")
        .textContent(),
    ).toBe("≤$0.20");

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
        },
      },
    ];
    await page.click("#history-refresh");
    await page.waitForFunction(
      () => document.querySelector("#spend-total")?.textContent === "Unavailable",
    );
    expect(await page.locator("#spend-total").textContent()).toBe("Unavailable");
    expect(await page.locator("#spend-total").textContent()).not.toBe("$0.00");
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
    await page.waitForSelector('.candidate-label span:text-is("running")');
    await page.click("#cancel");
    await page.waitForSelector('.candidate-label span:text-is("cancel-requested")');
    expect(await page.locator(".candidate-message").first().textContent()).toContain(
      "billing may still occur",
    );
    expect(await page.locator("#cancel").isDisabled()).toBe(true);
    expect(
      await page.locator("#cancel").evaluate((button) => getComputedStyle(button).borderColor),
    ).toBe("rgba(0, 0, 0, 0)");
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
});
