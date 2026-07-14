import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startWorkbench, validateUploadContentLength } from "../src/workbench/server";
import { pngBytes } from "./helpers";

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
    const publicHost = `test-vm.exe.xyz:${instance.server.port}`;
    const forwarded = {
      "x-workbench-token": instance.token,
      "x-forwarded-host": publicHost,
      "x-forwarded-proto": "https",
      origin: `https://${publicHost}`,
    };
    expect((await fetch(`${localOrigin}/api/bootstrap`, { headers: forwarded })).status).toBe(200);
    const launch = await fetch(instance.url, { headers: forwarded, redirect: "manual" });
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
