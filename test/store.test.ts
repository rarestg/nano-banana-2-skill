import { afterEach, describe, expect, test } from "bun:test";
import { readFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "../src/image-tools";
import {
  MAX_REFERENCE_BYTES,
  SessionStore,
  WorkbenchError,
  hashForTest,
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
    expect(recovered.arms[0].candidates[0].cancellation?.billing).toBe("unknown-may-be-charged");
    expect(recovered.arms[0].candidates[1].cancellation).toBeUndefined();
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
    const generated = svgResult("export").images;
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
  });

  test("removes a fully staged export if its manifest commit fails", async () => {
    const { root, store } = await temporaryStore();
    roots.push(root);
    const created = await store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const images = await store.saveCandidateImages(created.id, "candidate-1-1", svgResult().images);
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
});
