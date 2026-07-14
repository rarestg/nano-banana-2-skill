import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { JobQueue, type GenerationRunner } from "../src/workbench/jobs";
import { pngBytes, sessionInput, svgResult, temporaryStore } from "./helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded fair job queue", () => {
  test("runs four independent calls at concurrency two in round-robin style order", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const session = await store.createSession(
      sessionInput({
        recipeIds: ["folio-geometric-isometric", "folio-flat-cut-paper"],
        variantsPerRecipe: 2,
      }),
    );
    const started: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runner: GenerationRunner = async (request) => {
      started.push(request.prompt);
      active++;
      maxActive = Math.max(maxActive, active);
      await Bun.sleep(30);
      active--;
      return svgResult(String(started.length));
    };
    const queue = new JobQueue(store, "test-key", runner, 2);
    await queue.enqueueSession(session.id);
    await queue.waitForIdle();

    const final = await store.readSession(session.id);
    expect(maxActive).toBe(2);
    expect(started).toHaveLength(4);
    expect(started[0]).toContain("Flat geometric isometric");
    expect(started[1]).toContain("Flat cut-paper");
    expect(started[2]).toContain("Flat geometric isometric");
    expect(started[3]).toContain("Flat cut-paper");
    expect(
      final.arms.flatMap((arm) => arm.candidates).map((candidate) => candidate.status),
    ).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  test("keeps failed candidates visible and redacts the API key from durable errors", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const secret = "secret-test-key-123";
    const session = await store.createSession(
      sessionInput({
        recipeIds: ["folio-geometric-isometric", "folio-flat-cut-paper"],
        variantsPerRecipe: 1,
      }),
    );
    const queue = new JobQueue(store, secret, async (request) => {
      if (request.prompt.includes("cut-paper")) {
        throw new Error(`Provider rejected key=${secret}`);
      }
      return svgResult();
    });
    await queue.enqueueSession(session.id);
    await queue.waitForIdle();
    const final = await store.readSession(session.id);
    expect(final.arms[0].candidates[0].status).toBe("succeeded");
    expect(final.arms[1].candidates[0].status).toBe("failed");
    expect(final.arms[1].candidates[0].error).toContain("[redacted]");
    expect(JSON.stringify(final)).not.toContain(secret);
  });

  test("cancels queued calls without billing and labels an in-flight abort as billing unknown", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const session = await store.createSession(sessionInput());
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runner: GenerationRunner = (request) =>
      new Promise((_resolve, reject) => {
        markStarted();
        request.abortSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    const queue = new JobQueue(store, "test-key", runner, 1);
    await queue.enqueueSession(session.id);
    await started;
    await queue.cancelSession(session.id);
    await queue.waitForIdle();
    const final = await store.readSession(session.id);
    const candidates = final.arms[0].candidates;
    expect(candidates[0].status).toBe("cancel-requested");
    expect(candidates[0].cancellation?.billing).toBe("unknown-may-be-charged");
    expect(candidates[0].error).toContain("stopped locally");
    expect(candidates[0].error).not.toContain("AbortError");
    expect(candidates.slice(1).every((candidate) => candidate.status === "cancel-requested")).toBe(
      true,
    );
    expect(
      candidates.slice(1).every((candidate) => candidate.cancellation?.billing === "not-submitted"),
    ).toBe(true);
  });

  test("does not let cancellation overwrite a concurrently completed candidate", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const session = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    let markStarted!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runnerDone = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const queue = new JobQueue(
      store,
      "test-key",
      async () => {
        markStarted();
        await runnerDone;
        return svgResult("late");
      },
      1,
    );
    await queue.enqueueSession(session.id);
    await started;

    const images = await store.saveCandidateImages(
      session.id,
      "candidate-1-1",
      svgResult("known").images,
    );
    await store.updateSession(session.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "succeeded";
      candidate.images = images;
      candidate.usage = { promptTokens: 1 };
      candidate.cost = { status: "calculated", usd: 0.01, excludesGrounding: false };
    });
    await queue.cancelSession(session.id);
    finish();
    await queue.waitForIdle();

    const final = await store.readSession(session.id);
    const candidate = final.arms[0].candidates[0];
    expect(candidate.status).toBe("succeeded");
    expect(candidate.images).toEqual(images);
    expect(candidate.usage).toEqual({ promptTokens: 1 });
    expect(candidate.cost?.usd).toBe(0.01);
    expect(candidate.cancellation).toBeUndefined();
  });

  test("persists a terminal failure when a stored reference cannot be read", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const session = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [{ name: "reference.png", mimeType: "image/png", bytes: pngBytes() }],
      }),
    );
    await rm(store.pathInSession(session.id, session.references[0].path));
    let calls = 0;
    const queue = new JobQueue(store, "test-key", async () => {
      calls++;
      return svgResult();
    });
    await queue.enqueueSession(session.id);
    await queue.waitForIdle();

    const final = await store.readSession(session.id);
    expect(calls).toBe(0);
    expect(final.arms[0].candidates[0].status).toBe("failed");
    expect(final.arms[0].candidates[0].error).toBeTruthy();
  });
});
