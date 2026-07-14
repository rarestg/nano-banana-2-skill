import { describe, expect, test } from "bun:test";

import {
  announceExeDevWorkbench,
  discoverExeDevLaunchUrl,
  type ExeDevDiscoveryDependencies,
} from "../src/workbench/exe-dev";

const input = {
  bindHost: "0.0.0.0",
  port: 4173,
  token: "launch_token-123",
};

function reflection(defaultPort: unknown, status = 200) {
  return async () => Response.json({ default_port: defaultPort }, { status });
}

describe("exe.dev launch URL discovery", () => {
  test("builds explicit-port and default-port URLs for both wildcard binds", async () => {
    expect(
      await discoverExeDevLaunchUrl(input, {
        fetch: reflection(8000),
        hostname: () => "RareS-Housing",
      }),
    ).toBe("https://rares-housing.exe.xyz:4173/?token=launch_token-123");

    expect(
      await discoverExeDevLaunchUrl(
        { ...input, bindHost: "::", port: 8000 },
        {
          fetch: reflection(8000),
          hostname: () => "RARES-HOUSING.EXE.XYZ",
        },
      ),
    ).toBe("https://rares-housing.exe.xyz/?token=launch_token-123");
  });

  test("never probes for non-wildcard binds or app ports outside 3000 through 9999", async () => {
    let calls = 0;
    const fetch: NonNullable<ExeDevDiscoveryDependencies["fetch"]> = async () => {
      calls++;
      return Response.json({ default_port: 2999 });
    };
    for (const bindHost of ["127.0.0.1", "localhost", "::1", "192.0.2.1"]) {
      expect(
        await discoverExeDevLaunchUrl({ ...input, bindHost }, { fetch, hostname: () => "vm" }),
      ).toBeUndefined();
    }
    for (const port of [2999, 10_000, 4173.5, Number.NaN]) {
      expect(
        await discoverExeDevLaunchUrl({ ...input, port }, { fetch, hostname: () => "vm" }),
      ).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  test("accepts proxy-range boundaries and rejects invalid or unrelated hostnames before fetch", async () => {
    expect(
      await discoverExeDevLaunchUrl(
        { ...input, port: 3000 },
        { fetch: reflection(8000), hostname: () => "a" },
      ),
    ).toBe("https://a.exe.xyz:3000/?token=launch_token-123");
    expect(
      await discoverExeDevLaunchUrl(
        { ...input, port: 9999 },
        { fetch: reflection(8000), hostname: () => "a".repeat(63) },
      ),
    ).toBe(`https://${"a".repeat(63)}.exe.xyz:9999/?token=launch_token-123`);

    const invalid = [
      "",
      " localhost",
      "localhost",
      "127.0.0.1",
      "::1",
      "vm.internal",
      "vm.sub.exe.xyz",
      "vm.exe.xyz.",
      "vm_name",
      "vélo",
      "-vm",
      "vm-",
      "a".repeat(64),
    ];
    let calls = 0;
    for (const value of invalid) {
      expect(
        await discoverExeDevLaunchUrl(input, {
          fetch: async () => {
            calls++;
            return Response.json({ default_port: 8000 });
          },
          hostname: () => value,
        }),
      ).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  test("swallows Reflection, JSON, schema, and hostname failures", async () => {
    const dependencies: ExeDevDiscoveryDependencies[] = [
      { fetch: async () => Promise.reject(new Error("offline")), hostname: () => "vm" },
      { fetch: reflection(8000, 503), hostname: () => "vm" },
      { fetch: async () => new Response("not json"), hostname: () => "vm" },
      { fetch: async () => Response.json(null), hostname: () => "vm" },
      { fetch: async () => Response.json([]), hostname: () => "vm" },
      { fetch: async () => Response.json({}), hostname: () => "vm" },
      { fetch: reflection("8000"), hostname: () => "vm" },
      { fetch: reflection(0), hostname: () => "vm" },
      { fetch: reflection(65_536), hostname: () => "vm" },
      { fetch: reflection(4173.5), hostname: () => "vm" },
      {
        fetch: reflection(8000),
        hostname: () => {
          throw new Error("hostname unavailable");
        },
      },
    ];
    for (const dependency of dependencies) {
      expect(await discoverExeDevLaunchUrl(input, dependency)).toBeUndefined();
    }
  });

  test("aborts a slow Reflection request without throwing", async () => {
    let aborted = false;
    const fetch: NonNullable<ExeDevDiscoveryDependencies["fetch"]> = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    expect(
      await discoverExeDevLaunchUrl(input, { fetch, hostname: () => "vm", timeoutMs: 5 }),
    ).toBeUndefined();
    expect(aborted).toBe(true);
  });

  test("never sends the token to Reflection and prints the exact detected line", async () => {
    const messages: string[] = [];
    let calls = 0;
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const url = await announceExeDevWorkbench(input, {
      fetch: async (request, init) => {
        calls++;
        requestUrl = String(request);
        requestInit = init;
        return Response.json({ default_port: 8000 });
      },
      hostname: () => "rares-housing",
      log: (message) => messages.push(message),
    });
    expect(calls).toBe(1);
    expect(requestUrl).toBe("https://reflection.int.exe.xyz/default_port");
    expect(requestInit?.method).toBe("GET");
    expect(new Headers(requestInit?.headers).get("accept")).toBe("application/json");
    expect(requestInit?.signal).toBeInstanceOf(AbortSignal);
    expect(`${requestUrl}${JSON.stringify(requestInit)}`).not.toContain(input.token);
    expect(url).toBe("https://rares-housing.exe.xyz:4173/?token=launch_token-123");
    expect(messages).toEqual([
      "[nano-banana] Workbench (exe.dev): https://rares-housing.exe.xyz:4173/?token=launch_token-123",
    ]);
  });
});
