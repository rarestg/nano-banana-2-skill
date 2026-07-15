import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCommand } from "../src/image-tools";
import {
  hashForTest,
  MAX_REFERENCE_BYTES,
  SessionStore,
  WorkbenchError,
} from "../src/workbench/store";
import { pngBytes, sessionInput, svgResult, temporaryStore } from "./helpers";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable sessions", () => {
  test("copies ordered references, sanitizes names, hashes bytes, and renders prompt lineage", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const first = pngBytes();
    const second = pngBytes();
    const manifest = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [
          { name: "../../first weird.png", mimeType: "image/png", bytes: first },
          { name: "second.jpeg", mimeType: "image/png", bytes: second },
        ],
      }),
    );

    expect(manifest.references.map((reference) => reference.order)).toEqual([1, 2]);
    expect(manifest.references.map((reference) => reference.originalName)).toEqual([
      "first-weird.png",
      "second.jpeg",
    ]);
    expect(manifest.references.map((reference) => reference.sha256)).toEqual([
      hashForTest(first),
      hashForTest(second),
    ]);
    expect(manifest.arms[0].renderedPrompt).toContain(manifest.subject);
    expect(manifest.arms[0].promptSha256).toBe(hashForTest(manifest.arms[0].renderedPrompt));
    expect(manifest.arms[0].recipeSha256).toBe(
      hashForTest(JSON.stringify(manifest.arms[0].recipe)),
    );
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(() => store.pathInSession(manifest.id, "../../escape")).toThrow("escapes workbench");
  });

  test("requires confirmation above eight calls and schedules comparisons round-robin", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const input = sessionInput({
      recipeIds: [
        "folio-geometric-isometric",
        "folio-flat-cut-paper",
        "folio-restrained-screenprint",
      ],
      variantsPerRecipe: 4,
    });
    try {
      await store.createSession(input);
      throw new Error("Expected confirmation gate");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkbenchError);
      expect((error as WorkbenchError).code).toBe("confirmation_required");
      expect((error as WorkbenchError).details?.callCount).toBe(12);
    }
    const manifest = await store.createSession({ ...input, confirmationAcknowledged: true });
    expect(store.orderedCandidates(manifest).map((candidate) => candidate.id)).toEqual([
      "candidate-1-1",
      "candidate-2-1",
      "candidate-3-1",
      "candidate-1-2",
      "candidate-2-2",
      "candidate-3-2",
      "candidate-1-3",
      "candidate-2-3",
      "candidate-3-3",
      "candidate-1-4",
      "candidate-2-4",
      "candidate-3-4",
    ]);
  });

  test("requires square settings and square output for project-icon export", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    await expect(store.createSession(sessionInput({ aspectRatio: "16:9" }))).rejects.toMatchObject({
      code: "project_icon_requires_square",
    });

    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const nonSquareSvg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320"><rect width="640" height="320" fill="white"/></svg>',
    );
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: nonSquareSvg, mimeType: "image/svg+xml" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    await expect(store.exportCandidate(created.id, "candidate-1-1")).rejects.toMatchObject({
      code: "project_icon_requires_square",
    });
    const final = await store.readSession(created.id);
    expect(final.selectedCandidateId).toBeUndefined();
    expect(final.exports).toEqual([]);
  });

  test("copies parent references byte-for-byte into a derived session", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const referenceBytes = pngBytes();
    const parent = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [
          {
            name: "parent-style.png",
            mimeType: "image/png",
            bytes: referenceBytes,
          },
        ],
      }),
    );
    const child = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [],
        derivedFromSessionId: parent.id,
        inheritReferences: true,
      }),
    );
    expect(child.derivedFromSessionId).toBe(parent.id);
    expect(child.references[0].sha256).toBe(parent.references[0].sha256);
    expect(await readFile(store.pathInSession(child.id, child.references[0].path))).toEqual(
      Buffer.from(referenceBytes),
    );
  });

  test("refuses symlink escapes for reads, writes, and serving", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await symlink("/tmp", store.pathInSession(created.id, "candidates"));
    await expect(
      store.saveCandidateImages(created.id, "candidate-1-1", svgResult().images),
    ).rejects.toMatchObject({ code: "unsafe_storage_path" });

    const withReference = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [{ name: "safe.png", mimeType: "image/png", bytes: pngBytes() }],
      }),
    );
    const referencePath = store.pathInSession(withReference.id, withReference.references[0].path);
    await rm(referencePath);
    await symlink("/etc/hosts", referencePath);
    await expect(
      store.readSessionFile(withReference.id, withReference.references[0].path),
    ).rejects.toMatchObject({
      code: "unsafe_storage_path",
    });
  });

  test("rejects reference count and byte limits before writing a session", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    await expect(
      store.createSession(
        sessionInput({
          references: Array.from({ length: 15 }, (_, index) => ({
            name: `${index}.png`,
            mimeType: "image/png",
            bytes: new Uint8Array([index]),
          })),
        }),
      ),
    ).rejects.toMatchObject({ code: "too_many_references" });
    await expect(
      store.createSession(
        sessionInput({
          references: [
            {
              name: "too-large.png",
              mimeType: "image/png",
              bytes: new Uint8Array(MAX_REFERENCE_BYTES + 1),
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "reference_too_large" });
  });

  test("recovers running and queued work without surprise resubmission", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "running";
      manifest.arms[0].candidates[0].startedAt = new Date().toISOString();
    });

    const restarted = new SessionStore(root);
    await restarted.initialize();
    const recovered = await restarted.readSession(created.id);
    expect(recovered.arms[0].candidates.map((candidate) => candidate.status)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(recovered.status).toBe("interrupted");
    expect(
      (await restarted.listHistory()).find((session) => session.id === created.id)?.status,
    ).toBe("interrupted");
    expect(recovered.arms[0].candidates[0].cancellation?.billing).toBe("unknown-may-be-charged");
    expect(recovered.arms[0].candidates[1].cancellation).toBeUndefined();
  });

  test("keeps successful interrupted runs partial and fully cancelled runs cancelled", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const partial = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    const partialResult = await store.updateSession(partial.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[1].status = "interrupted";
    });
    expect(partialResult.status).toBe("partial");

    const cancelled = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    const cancelledResult = await store.updateSession(cancelled.id, (manifest) => {
      for (const candidate of manifest.arms[0].candidates) {
        candidate.status = "cancel-requested";
      }
    });
    expect(cancelledResult.status).toBe("cancelled");
  });

  test("atomically persists state and exports byte-identical raw plus circular-alpha RGBA PNG", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [{ name: "style.png", mimeType: "image/png", bytes: pngBytes() }],
      }),
    );
    const generated = [{ bytes: pngBytes(), mimeType: "image/png" }];
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", generated);
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "succeeded";
      candidate.images = images;
      candidate.completedAt = new Date().toISOString();
    });

    const result = await store.exportCandidate(created.id, "candidate-1-1");
    const rawPath = store.pathInSession(created.id, result.export.raw.path);
    const sourcePath = store.pathInSession(created.id, images[0].path);
    expect(await readFile(rawPath)).toEqual(await readFile(sourcePath));
    expect(result.export.raw.sha256).toBe(images[0].sha256);

    const production = result.export.production;
    if (!production) throw new Error("Expected a production icon export.");
    const productionPath = store.pathInSession(created.id, production.path);
    const png = await readFile(productionPath);
    expect(png.readUInt32BE(16)).toBe(384);
    expect(png.readUInt32BE(20)).toBe(384);
    expect(png[25]).toBe(6);
    const corner = await runCommand("convert", [
      productionPath,
      "-format",
      "%[pixel:p{0,0}]",
      "info:",
    ]);
    expect(corner.stdout).toMatch(/(?:rgba\([^)]*,0\)|#[0-9A-Fa-f]{6}00)/);

    const bundleManifestPath = store.pathInSession(
      created.id,
      join(result.export.directory, "manifest.json"),
    );
    expect(result.export.manifestSha256).toBeDefined();
    expect(hashForTest(await readFile(bundleManifestPath))).toBe(
      result.export.manifestSha256 ?? "",
    );
    expect(
      await readFile(
        store.pathInSession(created.id, join(result.export.directory, "references", "001.png")),
      ),
    ).toEqual(Buffer.from(pngBytes()));
    expect(
      (await readdir(store.sessionDirectory(created.id))).some((entry) => entry.endsWith(".tmp")),
    ).toBe(false);
  }, 15_000);

  test("export preserves an existing primary in session and bundle manifests", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ recipeIds: ["custom"], variantsPerRecipe: 1 }),
    );
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    await store.selectCandidate(created.id, "candidate-1-1");

    const result = await store.exportCandidate(created.id, "candidate-1-1");
    const bundle = JSON.parse(
      await readFile(
        store.pathInSession(created.id, join(result.export.directory, "manifest.json")),
        "utf8",
      ),
    );

    expect(result.manifest.selectedCandidateId).toBe("candidate-1-1");
    expect((await store.readSession(created.id)).selectedCandidateId).toBe("candidate-1-1");
    expect(bundle.selectedCandidateId).toBe("candidate-1-1");
  });

  test("clears the primary without changing candidate selection rules", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const images = await store.saveCandidateImages(
      created.id,
      "candidate-1-1",
      svgResult("primary").images,
    );
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    await store.selectCandidate(created.id, "candidate-1-1");

    const cleared = await store.selectCandidate(created.id, null);
    const persisted = JSON.parse(
      await readFile(store.pathInSession(created.id, "manifest.json"), "utf8"),
    );

    expect(cleared.selectedCandidateId).toBeUndefined();
    expect(persisted).not.toHaveProperty("selectedCandidateId");
  });

  test("exporting a different candidate does not change the primary", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ recipeIds: ["custom"], variantsPerRecipe: 2 }),
    );
    const primaryImages = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    const exportedImages = await store.saveCandidateImages(created.id, "candidate-1-2", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = primaryImages;
      manifest.arms[0].candidates[1].status = "succeeded";
      manifest.arms[0].candidates[1].images = exportedImages;
    });
    await store.selectCandidate(created.id, "candidate-1-1");

    const result = await store.exportCandidate(created.id, "candidate-1-2");
    const bundle = JSON.parse(
      await readFile(
        store.pathInSession(created.id, join(result.export.directory, "manifest.json")),
        "utf8",
      ),
    );

    expect(result.manifest.selectedCandidateId).toBe("candidate-1-1");
    expect((await store.readSession(created.id)).selectedCandidateId).toBe("candidate-1-1");
    expect(bundle.selectedCandidateId).toBe("candidate-1-1");
  }, 15_000);

  test("repeated exports preserve the primary", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ recipeIds: ["custom"], variantsPerRecipe: 2 }),
    );
    const primaryImages = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    const exportedImages = await store.saveCandidateImages(created.id, "candidate-1-2", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = primaryImages;
      manifest.arms[0].candidates[1].status = "succeeded";
      manifest.arms[0].candidates[1].images = exportedImages;
    });
    await store.selectCandidate(created.id, "candidate-1-1");

    const first = await store.exportCandidate(created.id, "candidate-1-2");
    const second = await store.exportCandidate(created.id, "candidate-1-2");
    const third = await store.exportCandidate(created.id, "candidate-1-1");

    expect(first.manifest.selectedCandidateId).toBe("candidate-1-1");
    expect(second.manifest.selectedCandidateId).toBe("candidate-1-1");
    expect(third.manifest.selectedCandidateId).toBe("candidate-1-1");
    expect((await store.readSession(created.id)).selectedCandidateId).toBe("candidate-1-1");
  });

  test("removes a fully staged export if its manifest commit fails", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ recipeIds: ["custom"], variantsPerRecipe: 1 }),
    );
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });

    Object.defineProperty(store, "updateSession", {
      configurable: true,
      value: async () => {
        throw new Error("simulated manifest commit failure");
      },
    });
    await expect(store.exportCandidate(created.id, "candidate-1-1")).rejects.toThrow(
      "simulated manifest commit failure",
    );
    const exportsDirectory = store.pathInSession(created.id, "exports");
    expect(await readdir(exportsDirectory)).toEqual([]);
    const persisted = JSON.parse(
      await readFile(store.pathInSession(created.id, "manifest.json"), "utf8"),
    );
    expect(persisted.selectedCandidateId).toBeUndefined();
    expect(persisted.exports).toEqual([]);
  });

  test("clears all sessions with their generated and exported files and stays usable", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    expect(await store.clearAllSessions()).toEqual({ cleared: 0 });

    const created = await store.createSession(
      sessionInput({
        variantsPerRecipe: 1,
        references: [{ name: "style.png", mimeType: "image/png", bytes: pngBytes() }],
      }),
    );
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", [
      { bytes: pngBytes(), mimeType: "image/png" },
    ]);
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    const exported = await store.exportCandidate(created.id, "candidate-1-1");
    const sessionDirectory = store.sessionDirectory(created.id);
    const generatedPath = store.pathInSession(created.id, images[0].path);
    const exportedRawPath = store.pathInSession(created.id, exported.export.raw.path);
    expect(existsSync(generatedPath)).toBe(true);
    expect(existsSync(exportedRawPath)).toBe(true);
    expect((await store.listHistory()).length).toBe(1);

    expect(await store.clearAllSessions()).toEqual({ cleared: 1 });
    expect(await store.listHistory()).toEqual([]);
    expect(existsSync(sessionDirectory)).toBe(false);
    expect(existsSync(generatedPath)).toBe(false);
    expect(existsSync(exportedRawPath)).toBe(false);
    expect(existsSync(store.sessionsRoot)).toBe(true);

    const after = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    expect((await store.readSession(after.id)).id).toBe(after.id);
    expect((await store.listHistory()).map((item) => item.id)).toEqual([after.id]);
  }, 15_000);

  test("recreates a missing sessions root when clearing", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    await rm(store.sessionsRoot, { recursive: true, force: true });
    expect(await store.clearAllSessions()).toEqual({ cleared: 0 });
    expect(existsSync(store.sessionsRoot)).toBe(true);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    expect((await store.readSession(created.id)).id).toBe(created.id);
  });

  test("refuses to clear history through a symlinked sessions root", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await rm(store.sessionsRoot, { recursive: true, force: true });
    const target = await mkdtemp(join(tmpdir(), "nano-banana-clear-target-"));
    roots.push(target);
    const sentinel = join(target, "sentinel");
    await writeFile(sentinel, "preserve");
    await symlink(target, store.sessionsRoot);
    await expect(store.clearAllSessions()).rejects.toMatchObject({ code: "unsafe_storage_path" });
    expect(await readFile(sentinel, "utf8")).toBe("preserve");
  });

  test("reports corrupt history and still clears its physical session", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await writeFile(store.pathInSession(created.id, "manifest.json"), "{}");
    const restarted = new SessionStore(root);
    await restarted.initialize();

    await expect(restarted.listHistory()).rejects.toMatchObject({ code: "history_read_failed" });
    expect(await restarted.clearAllSessions()).toEqual({ cleared: 1 });
    expect(existsSync(restarted.sessionDirectory(created.id))).toBe(false);
  });

  test("maps ordinary clear preflight I/O errors without masking safety refusals", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    await rm(store.sessionsRoot, { recursive: true, force: true });
    await writeFile(store.sessionsRoot, "not a directory");

    await expect(store.clearAllSessions()).rejects.toMatchObject({ code: "history_clear_failed" });
  });

  test("history reports successful image count and complete calculated spend", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const images = await store.saveCandidateImages(
      created.id,
      "candidate-1-1",
      svgResult("complete").images,
    );
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "succeeded";
      candidate.images = images;
      candidate.cost = { status: "calculated", usd: 0.25, excludesGrounding: false };
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.generatedImageCount).toBe(1);
    expect(summary?.spend).toEqual({
      status: "complete",
      calculatedUsd: 0.25,
      upperBoundUsd: undefined,
      calculatedCount: 1,
      upperBoundCount: 0,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    });
  });

  test("history treats failed calls without cost data as unavailable, not zero", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "failed";
      manifest.arms[0].candidates[0].error = "Provider failed without usage.";
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.generatedImageCount).toBe(0);
    expect(summary?.spend.status).toBe("unavailable");
    expect(summary?.spend.calculatedUsd).toBeUndefined();
    expect(summary?.spend.upperBoundUsd).toBeUndefined();
    expect(summary?.spend.unavailableCount).toBe(1);
  });

  test("history distinguishes unknown cancellation billing from not-submitted calls", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    await store.updateSession(created.id, (manifest) => {
      const [active, queued] = manifest.arms[0].candidates;
      active.status = "cancel-requested";
      active.cancellation = {
        requestedAt: new Date().toISOString(),
        billing: "unknown-may-be-charged",
      };
      queued.status = "cancel-requested";
      queued.cancellation = {
        requestedAt: new Date().toISOString(),
        billing: "not-submitted",
      };
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.spend.status).toBe("unavailable");
    expect(summary?.spend.unknownMayBeChargedCount).toBe(1);
    expect(summary?.spend.unavailableCount).toBe(0);
    expect(summary?.spend.calculatedUsd).toBeUndefined();
  });

  test("history counts explicit unavailable costs", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const images = await store.saveCandidateImages(
      created.id,
      "candidate-1-1",
      svgResult("unavailable").images,
    );
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "succeeded";
      candidate.images = images;
      candidate.cost = { status: "unavailable", excludesGrounding: false };
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.generatedImageCount).toBe(1);
    expect(summary?.spend.status).toBe("unavailable");
    expect(summary?.spend.unavailableCount).toBe(1);
    expect(summary?.spend.calculatedUsd).toBeUndefined();
  });

  test("history separates calculated and upper-bound spend in a fully accounted mixture", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    await store.updateSession(created.id, (manifest) => {
      const [calculated, upperBound] = manifest.arms[0].candidates;
      calculated.status = "failed";
      calculated.cost = { status: "calculated", usd: 0.1, excludesGrounding: false };
      upperBound.status = "failed";
      upperBound.cost = { status: "upper-bound", usd: 0.2, excludesGrounding: false };
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.spend).toEqual({
      status: "upper-bound",
      calculatedUsd: 0.1,
      upperBoundUsd: 0.2,
      calculatedCount: 1,
      upperBoundCount: 1,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 0,
    });
  });

  test("history preserves a grounded image subtotal but marks grounding charges unknown", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ googleSearch: true, variantsPerRecipe: 1 }),
    );
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "failed";
      candidate.cost = { status: "calculated", usd: 0.1, excludesGrounding: true };
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.spend).toEqual({
      status: "partial",
      calculatedUsd: 0.1,
      upperBoundUsd: undefined,
      calculatedCount: 1,
      upperBoundCount: 0,
      unavailableCount: 0,
      unknownMayBeChargedCount: 0,
      unknownGroundingChargeCount: 1,
    });
  });

  test("rejects grounded stored costs that claim to include grounding", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(
      sessionInput({ googleSearch: true, variantsPerRecipe: 1 }),
    );
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "failed";
      candidate.cost = { status: "calculated", usd: 0.1, excludesGrounding: false };
    });

    await expect(store.listHistory()).rejects.toMatchObject({ code: "history_read_failed" });
  });

  test("rejects non-grounded stored costs that claim grounding was excluded", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await store.updateSession(created.id, (manifest) => {
      const candidate = manifest.arms[0].candidates[0];
      candidate.status = "failed";
      candidate.cost = { status: "calculated", usd: 0.1, excludesGrounding: true };
    });

    await expect(store.listHistory()).rejects.toMatchObject({ code: "history_read_failed" });
  });

  test("rejects an unknown cost status in a stored manifest", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const manifestPath = store.pathInSession(created.id, "manifest.json");
    const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
      arms: Array<{ candidates: Array<Record<string, unknown>> }>;
    };
    persisted.arms[0].candidates[0].cost = {
      status: "unknown",
      excludesGrounding: false,
    };
    await writeFile(manifestPath, JSON.stringify(persisted));

    await expect(store.listHistory()).rejects.toMatchObject({ code: "history_read_failed" });
  });

  test("rejects calculated and upper-bound stored costs without USD", async () => {
    for (const status of ["calculated", "upper-bound"]) {
      const { root, store } = await temporaryStore();
      roots.push(root);
      const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
      const manifestPath = store.pathInSession(created.id, "manifest.json");
      const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as {
        arms: Array<{ candidates: Array<Record<string, unknown>> }>;
      };
      persisted.arms[0].candidates[0].cost = { status, excludesGrounding: false };
      await writeFile(manifestPath, JSON.stringify(persisted));

      await expect(store.listHistory()).rejects.toMatchObject({ code: "history_read_failed" });
    }
  });

  test("history marks a known subtotal partial when another call has unknown cost", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 2 }));
    await store.updateSession(created.id, (manifest) => {
      const [known, unknown] = manifest.arms[0].candidates;
      known.status = "failed";
      known.cost = { status: "calculated", usd: 0.1, excludesGrounding: false };
      unknown.status = "failed";
    });

    const summary = (await store.listHistory()).find((item) => item.id === created.id);

    expect(summary?.spend.status).toBe("partial");
    expect(summary?.spend.calculatedUsd).toBe(0.1);
    expect(summary?.spend.unavailableCount).toBe(1);
  });
});
