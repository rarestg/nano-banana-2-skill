import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const externalCwd = await mkdtemp(join(tmpdir(), "nano-banana-built-cwd-"));
const home = await mkdtemp(join(tmpdir(), "nano-banana-built-home-"));
const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") });
const port = probe.port;
probe.stop(true);

const child = Bun.spawn(
  ["bun", join(repositoryRoot, "dist", "cli.js"), "workbench", "--port", String(port)],
  {
    cwd: externalCwd,
    env: {
      ...process.env,
      HOME: home,
      NANO_BANANA_TEST_NO_API_KEY: "1",
      NANO_BANANA_WORKBENCH_MOCK: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);

try {
  const reader = child.stdout.getReader();
  let output = "";
  const deadline = Date.now() + 10_000;
  let launchUrl: string | undefined;
  while (!launchUrl && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(250).then(() => ({ done: false as const, value: new Uint8Array() })),
    ]);
    if (next.done) break;
    output += new TextDecoder().decode(next.value);
    launchUrl = output.match(/http:\/\/[^\s]+\?token=[A-Za-z0-9_-]+/)?.[0];
  }
  if (!launchUrl) throw new Error(`Built workbench did not start: ${output}`);

  const launch = await fetch(launchUrl, { redirect: "manual" });
  if (launch.status !== 303 || launch.headers.get("location") !== "/") {
    throw new Error("Built workbench did not exchange its launch token for a cookie.");
  }
  const cookie = launch.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Built workbench did not set its auth cookie.");
  const origin = new URL(launchUrl).origin;
  const root = await fetch(`${origin}/`, { headers: { cookie } });
  const bootstrap = await fetch(`${origin}/api/bootstrap`, { headers: { cookie } });
  const styles = await fetch(`${origin}/styles.css`, { headers: { cookie } });
  const body = (await bootstrap.json()) as {
    recipes?: unknown[];
    palettes?: unknown[];
    models?: unknown[];
  };
  if (
    !root.ok ||
    !styles.ok ||
    !bootstrap.ok ||
    body.recipes?.length !== 10 ||
    body.palettes?.length !== 7 ||
    !body.models?.length
  ) {
    throw new Error("Built workbench could not load packaged web/recipe assets.");
  }
  console.log("Built workbench external-cwd smoke passed.");
} finally {
  child.kill("SIGTERM");
  await child.exited;
  await Promise.all([externalCwd, home].map((path) => rm(path, { recursive: true, force: true })));
}
