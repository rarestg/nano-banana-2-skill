import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverExeDevLaunchUrl } from "../src/workbench/exe-dev";
import { startWorkbench, validateUploadContentLength } from "../src/workbench/server";
import { pngBytes, sessionInput, svgResult } from "./helpers";

const instances: Array<Awaited<ReturnType<typeof startWorkbench>>> = [];
const roots: string[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) instance.server.stop(true);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function server() {
  const root = await mkdtemp(join(tmpdir(), "nano-banana-server-test-"));
  const instance = await startWorkbench({ port: 0, mock: true, storageRoot: root });
  instances.push(instance);
  roots.push(root);
  const origin = new URL(instance.url).origin;
  return { instance, origin };
}

function headers(instance: Awaited<ReturnType<typeof startWorkbench>>, origin: string) {
  return { "x-workbench-token": instance.token, origin };
}

describe("local server safety", () => {
  test("rejects unknown and chunked upload lengths before parsing", () => {
    expect(() =>
      validateUploadContentLength(
        new Request("http://localhost/upload", { method: "POST", body: "body" }),
      ),
    ).toThrow("Content-Length is required");
    expect(() =>
      validateUploadContentLength(
        new Request("http://localhost/upload", {
          method: "POST",
          headers: { "content-length": "4", "transfer-encoding": "chunked" },
          body: "body",
        }),
      ),
    ).toThrow("Chunked uploads are not accepted");
  });

  test("requires the launch token and validates Host and Origin without CORS", async () => {
    const { instance, origin } = await server();
    expect((await fetch(`${origin}/api/bootstrap`)).status).toBe(401);

    const bootstrap = await fetch(`${origin}/api/bootstrap`, {
      headers: { "x-workbench-token": instance.token },
    });
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("access-control-allow-origin")).toBeNull();
    expect(JSON.stringify(await bootstrap.json())).not.toContain("mock-workbench-key");

    const noOrigin = await fetch(`${origin}/api/sessions/anything/cancel`, {
      method: "POST",
      headers: { "x-workbench-token": instance.token },
    });
    expect(noOrigin.status).toBe(403);
    const badOrigin = await fetch(`${origin}/api/sessions/anything/cancel`, {
      method: "POST",
      headers: { "x-workbench-token": instance.token, origin: "https://evil.example" },
    });
    expect(badOrigin.status).toBe(403);
    const wrongScheme = await fetch(`${origin}/api/sessions/anything/cancel`, {
      method: "POST",
      headers: { "x-workbench-token": instance.token, origin: origin.replace("http:", "https:") },
    });
    expect(wrongScheme.status).toBe(403);
    const badHost = await fetch(`${origin}/api/bootstrap`, {
      headers: { "x-workbench-token": instance.token, host: "evil.example" },
    });
    expect(badHost.status).toBe(403);
  });

  test("reports missing-key state without exposing any key material", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-no-key-test-"));
    const previous = process.env.NANO_BANANA_TEST_NO_API_KEY;
    process.env.NANO_BANANA_TEST_NO_API_KEY = "1";
    let instance: Awaited<ReturnType<typeof startWorkbench>>;
    try {
      instance = await startWorkbench({ port: 0, storageRoot: root });
    } finally {
      if (previous === undefined) delete process.env.NANO_BANANA_TEST_NO_API_KEY;
      else process.env.NANO_BANANA_TEST_NO_API_KEY = previous;
    }
    instances.push(instance);
    roots.push(root);
    const origin = new URL(instance.url).origin;
    const response = await fetch(`${origin}/api/bootstrap`, {
      headers: { "x-workbench-token": instance.token },
    });
    const body = await response.json();
    expect(body.keyConfigured).toBe(false);
    expect(body.storageDisplayRoot).toBe(root);
    expect(JSON.stringify(body)).not.toContain("GEMINI_API_KEY");
  });

  test("reconstructs the full exe.dev origin from documented forwarded headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-exe-origin-test-"));
    const instance = await startWorkbench({
      host: "0.0.0.0",
      port: 0,
      mock: true,
      storageRoot: root,
    });
    instances.push(instance);
    roots.push(root);
    const localOrigin = new URL(instance.url).origin;
    const publicUrl = await discoverExeDevLaunchUrl(
      { bindHost: "0.0.0.0", port: 4173, token: instance.token },
      {
        fetch: async () => Response.json({ default_port: 8000 }),
        hostname: () => "test-vm",
      },
    );
    expect(publicUrl).toBe(`https://test-vm.exe.xyz:4173/?token=${instance.token}`);
    const publicHost = new URL(publicUrl ?? "https://invalid.example").host;
    const forwarded = {
      "x-workbench-token": instance.token,
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "https",
      origin: `https://${publicHost}`,
    };
    expect((await fetch(`${localOrigin}/api/bootstrap`, { headers: forwarded })).status).toBe(200);
    const launch = await fetch(instance.url, { headers: forwarded, redirect: "manual" });
    expect(launch.status).toBe(303);
    expect(launch.headers.get("location")).toBe("/");
    expect(launch.headers.get("set-cookie")).toContain("HttpOnly");
    expect(launch.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(launch.headers.get("set-cookie")).toContain("Secure");
    const acceptedOrigin = await fetch(`${localOrigin}/api/sessions/missing/cancel`, {
      method: "POST",
      headers: forwarded,
    });
    expect(acceptedOrigin.status).toBe(400);
    const rejectedScheme = await fetch(`${localOrigin}/api/sessions/missing/cancel`, {
      method: "POST",
      headers: { ...forwarded, origin: `http://${publicHost}` },
    });
    expect(rejectedScheme.status).toBe(403);
    const rejectedPort = await fetch(`${localOrigin}/api/sessions/missing/cancel`, {
      method: "POST",
      headers: {
        ...forwarded,
        "x-forwarded-host": "test-vm.exe.xyz:4174",
        origin: `https://${publicHost}`,
      },
    });
    expect(rejectedPort.status).toBe(403);
    const rejectedHost = await fetch(`${localOrigin}/api/sessions/missing/cancel`, {
      method: "POST",
      headers: {
        ...forwarded,
        "x-forwarded-host": "test-vm.exe.xyz.evil.example",
        origin: "https://test-vm.exe.xyz.evil.example",
      },
    });
    expect(rejectedHost.status).toBe(403);

    const defaultPortUrl = await discoverExeDevLaunchUrl(
      { bindHost: "0.0.0.0", port: 4173, token: instance.token },
      {
        fetch: async () => Response.json({ default_port: 4173 }),
        hostname: () => "test-vm",
      },
    );
    expect(defaultPortUrl).toBe(`https://test-vm.exe.xyz/?token=${instance.token}`);
    const defaultForwarded = {
      ...forwarded,
      "x-forwarded-host": "test-vm.exe.xyz",
      origin: "https://test-vm.exe.xyz",
    };
    expect(
      (
        await fetch(`${localOrigin}/api/sessions/missing/cancel`, {
          method: "POST",
          headers: defaultForwarded,
        })
      ).status,
    ).toBe(400);
  });

  test("exchanges the launch query for a cookie and never emits token-bearing resource URLs", async () => {
    const { instance, origin } = await server();
    const launch = await fetch(instance.url, { redirect: "manual" });
    expect(launch.status).toBe(303);
    expect(launch.headers.get("location")).toBe("/");
    const cookie = launch.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeDefined();
    const root = await fetch(`${origin}/`, { headers: { cookie: cookie ?? "" } });
    expect(root.status).toBe(200);
    const script = await (
      await fetch(`${origin}/app.js`, { headers: { cookie: cookie ?? "" } })
    ).text();
    expect(script).not.toContain('searchParams.get("token")');
    expect(script).not.toContain("?token=");
    expect((await fetch(`${origin}/api/bootstrap?token=${instance.token}`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/api/bootstrap`, { headers: { cookie: cookie ?? "" } })).status,
    ).toBe(200);
  });

  test("strictly rejects string booleans, numeric strings, arrays, and unknown fields", async () => {
    const { instance, origin } = await server();
    const base = {
      subject: "Strict payload",
      recipeIds: ["folio-geometric-isometric"],
      modelId: "gemini-3.1-flash-image",
      size: "512",
      aspectRatio: "1:1",
      googleSearch: false,
      variantsPerRecipe: 1,
    };
    for (const payload of [
      { ...base, googleSearch: "false" },
      { ...base, confirmationAcknowledged: "false" },
      { ...base, variantsPerRecipe: "1" },
      { ...base, subject: ["not", "a", "string"] },
      { ...base, unexpected: true },
    ]) {
      const form = new FormData();
      form.set("payload", JSON.stringify(payload));
      const response = await fetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: headers(instance, origin),
        body: form,
      });
      expect(response.status).toBe(400);
    }
    for (const body of [{ candidateId: false }, { candidateId: "candidate-1-1", extra: true }]) {
      const response = await fetch(`${origin}/api/sessions/not-a-session/select`, {
        method: "POST",
        headers: { ...headers(instance, origin), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  test("accepts null candidateId only for clearing the primary", async () => {
    const { instance, origin } = await server();
    const session = await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const images = await instance.store.saveCandidateImages(
      session.id,
      "candidate-1-1",
      svgResult("primary").images,
    );
    await instance.store.updateSession(session.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    await instance.store.selectCandidate(session.id, "candidate-1-1");

    const clear = await fetch(`${origin}/api/sessions/${session.id}/select`, {
      method: "POST",
      headers: { ...headers(instance, origin), "content-type": "application/json" },
      body: JSON.stringify({ candidateId: null }),
    });
    const clearBody = await clear.json();
    const invalidExport = await fetch(`${origin}/api/sessions/${session.id}/export`, {
      method: "POST",
      headers: { ...headers(instance, origin), "content-type": "application/json" },
      body: JSON.stringify({ candidateId: null }),
    });

    expect(clear.status).toBe(200);
    expect(clearBody.session).not.toHaveProperty("selectedCandidateId");
    expect((await instance.store.readSession(session.id)).selectedCandidateId).toBeUndefined();
    expect(invalidExport.status).toBe(400);
  });

  test("history omits dollar subtotals when spend is unavailable", async () => {
    const { instance, origin } = await server();
    const session = await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await instance.store.updateSession(session.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "failed";
    });

    const response = await fetch(`${origin}/api/history`, {
      headers: { "x-workbench-token": instance.token },
    });
    const body = await response.json();
    const summary = body.sessions.find((item: { id: string }) => item.id === session.id);

    expect(response.status).toBe(200);
    expect(summary.generatedImageCount).toBe(0);
    expect(summary.spend.status).toBe("unavailable");
    expect(summary.spend).not.toHaveProperty("calculatedUsd");
    expect(summary.spend).not.toHaveProperty("upperBoundUsd");
    expect(summary).not.toHaveProperty("usageCostUsd");
  });

  test("round-trips interrupted session status through session and history APIs", async () => {
    const { instance, origin } = await server();
    const created = await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await instance.store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "interrupted";
    });

    const sessionResponse = await fetch(`${origin}/api/sessions/${created.id}`, {
      headers: headers(instance, origin),
    });
    expect(sessionResponse.status).toBe(200);
    expect((await sessionResponse.json()).session.status).toBe("interrupted");

    const historyResponse = await fetch(`${origin}/api/history`, {
      headers: headers(instance, origin),
    });
    expect(historyResponse.status).toBe(200);
    expect((await historyResponse.json()).sessions[0].status).toBe("interrupted");
  });

  test("downloads selected final assets as a ZIP without recording an export", async () => {
    const { instance, origin } = await server();
    const created = await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    const generated = svgResult("browser download");
    const images = await instance.store.saveCandidateImages(
      created.id,
      "candidate-1-1",
      generated.images,
    );
    await instance.store.updateSession(created.id, (manifest) => {
      manifest.arms[0].candidates[0].status = "succeeded";
      manifest.arms[0].candidates[0].images = images;
    });
    const before = await instance.store.readSession(created.id);
    const response = await fetch(
      `${origin}/api/sessions/${created.id}/download?candidateId=candidate-1-1`,
      { headers: { "x-workbench-token": instance.token } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="nano-banana-${created.id}.zip"`,
    );
    const archive = new Uint8Array(await response.arrayBuffer());
    expect([...archive.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(archive);
    expect(text).toContain("01-folio-geometric-isometric-variant-1.png");
    expect(text).toContain("manifest.txt");
    expect(text).toContain("Folio geometric isometric");
    expect(await instance.store.readSession(created.id)).toEqual(before);

    const duplicate = await fetch(
      `${origin}/api/sessions/${created.id}/download?candidateId=candidate-1-1&candidateId=candidate-1-1`,
      { headers: { "x-workbench-token": instance.token } },
    );
    expect(duplicate.status).toBe(400);
    const unknownField = await fetch(
      `${origin}/api/sessions/${created.id}/download?candidateId=candidate-1-1&extra=true`,
      { headers: { "x-workbench-token": instance.token } },
    );
    expect(unknownField.status).toBe(400);
  });

  function createSessionForm(subject: string) {
    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        subject,
        recipeIds: ["custom"],
        modelId: "gemini-3.1-flash-image",
        size: "512",
        aspectRatio: "1:1",
        googleSearch: false,
        variantsPerRecipe: 1,
      }),
    );
    return form;
  }

  test("clears history over DELETE with auth and origin, and stays idempotent", async () => {
    const { instance, origin } = await server();
    await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));

    expect(
      (await fetch(`${origin}/api/history`, { method: "DELETE", headers: { origin } })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/history`, {
          method: "DELETE",
          headers: { "x-workbench-token": instance.token },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/history`, {
          method: "DELETE",
          headers: { "x-workbench-token": instance.token, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);

    const cleared = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: 1 });
    expect((await instance.store.listHistory()).length).toBe(0);

    const again = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ cleared: 0 });
  });

  test("reports corrupt history but can still clear its physical session", async () => {
    const { instance, origin } = await server();
    const created = await instance.store.createSession(sessionInput({ variantsPerRecipe: 1 }));
    await writeFile(instance.store.pathInSession(created.id, "manifest.json"), "{not-json");

    const history = await fetch(`${origin}/api/history`, { headers: headers(instance, origin) });
    expect(history.status).toBe(500);
    expect((await history.json()).error.code).toBe("history_read_failed");

    const cleared = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ cleared: 1 });
  });

  test("refuses to clear history while a generation is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "nano-banana-clear-busy-test-"));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const finished = new Promise<void>((resolve) => {
      release = resolve;
    });
    const instance = await startWorkbench({
      port: 0,
      storageRoot: root,
      runner: async () => {
        markStarted();
        await finished;
        return svgResult();
      },
    });
    instances.push(instance);
    roots.push(root);
    const origin = new URL(instance.url).origin;

    const created = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: createSessionForm("Busy clear guard"),
    });
    expect(created.status).toBe(201);
    await started;

    const busy = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("history_busy");
    expect((await instance.store.listHistory()).length).toBe(1);

    release();
    await instance.queue?.waitForIdle();
    const ok = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ cleared: 1 });
  }, 15_000);

  test("serializes a clear-all behind an in-progress create", async () => {
    const { instance, origin } = await server();
    let releaseCreate!: () => void;
    const createPaused = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const originalCreate = instance.store.createSession.bind(instance.store);
    Object.defineProperty(instance.store, "createSession", {
      configurable: true,
      value: async (input: Parameters<typeof originalCreate>[0]) => {
        markEntered();
        await createPaused;
        return originalCreate(input);
      },
    });

    const createPromise = fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: createSessionForm("Serialized create"),
    });
    await entered;

    let clearResolved = false;
    const clearPromise = fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    }).then((response) => {
      clearResolved = true;
      return response;
    });
    await Bun.sleep(60);
    expect(clearResolved).toBe(false);

    releaseCreate();
    const [createResponse, clearResponse] = await Promise.all([createPromise, clearPromise]);
    expect(createResponse.status).toBe(201);
    // The create enqueues a hanging-free mock job; by the time the gate releases
    // that job is already active, so the serialized clear correctly sees it busy
    // rather than deleting mid-create.
    expect(clearResponse.status).toBe(409);
    expect((await clearResponse.json()).error.code).toBe("history_busy");

    await instance.queue?.waitForIdle();
    const finalClear = await fetch(`${origin}/api/history`, {
      method: "DELETE",
      headers: headers(instance, origin),
    });
    expect(finalClear.status).toBe(200);
    expect(await finalClear.json()).toEqual({ cleared: 1 });
  }, 15_000);

  test("rejects hostile uploads and preserves sanitized ordered filenames", async () => {
    const { instance, origin } = await server();
    const invalid = new FormData();
    invalid.set(
      "payload",
      JSON.stringify({
        subject: "Test",
        recipeIds: ["custom"],
        modelId: "gemini-3.1-flash-image",
        size: "512",
        aspectRatio: "1:1",
        googleSearch: false,
        variantsPerRecipe: 1,
      }),
    );
    invalid.append("references", new File(["text"], "bad.txt", { type: "text/plain" }));
    const rejected = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: invalid,
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe("invalid_reference_type");

    const fakePng = new FormData();
    fakePng.set("payload", invalid.get("payload") as string);
    fakePng.append("references", new File(["not a png"], "fake.png", { type: "image/png" }));
    const fakeRejected = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: fakePng,
    });
    expect(fakeRejected.status).toBe(400);
    expect((await fakeRejected.json()).error.code).toBe("invalid_reference_type");

    const truncatedPng = new FormData();
    truncatedPng.set("payload", invalid.get("payload") as string);
    truncatedPng.append(
      "references",
      new File([pngBytes().subarray(0, 16)], "truncated.png", { type: "image/png" }),
    );
    const decodeRejected = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: truncatedPng,
    });
    expect(decodeRejected.status).toBe(400);
    expect((await decodeRejected.json()).error.code).toBe("invalid_reference_content");

    const form = new FormData();
    form.set(
      "payload",
      JSON.stringify({
        subject: "Safe upload test",
        recipeIds: ["custom"],
        modelId: "gemini-3.1-flash-image",
        size: "512",
        aspectRatio: "1:1",
        googleSearch: false,
        variantsPerRecipe: 1,
      }),
    );
    form.append(
      "references",
      new File([pngBytes()], "../../first weird.png", { type: "image/png" }),
    );
    form.append("references", new File([pngBytes()], "second.png", { type: "image/png" }));
    const createdResponse = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: headers(instance, origin),
      body: form,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json();
    expect(
      created.session.references.map(
        (reference: { originalName: string }) => reference.originalName,
      ),
    ).toEqual(["first-weird.png", "second.png"]);
    await instance.queue?.waitForIdle();
    const session = await (
      await fetch(`${origin}/api/sessions/${created.session.id}`, {
        headers: { "x-workbench-token": instance.token },
      })
    ).json();
    expect(session.session.arms[0].candidates[0].status).toBe("succeeded");
    const fileUrl = `${origin}/api/sessions/${created.session.id}/candidates/candidate-1-1/images/0`;
    expect((await fetch(fileUrl)).status).toBe(401);
    expect(
      (await fetch(fileUrl, { headers: { "x-workbench-token": instance.token } })).status,
    ).toBe(200);
  });
});
