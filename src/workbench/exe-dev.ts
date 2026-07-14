import { hostname as systemHostname } from "node:os";

const REFLECTION_DEFAULT_PORT_URL = "https://reflection.int.exe.xyz/default_port";
const MIN_PROXY_PORT = 3000;
const MAX_PROXY_PORT = 9999;
const VM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type ReflectionFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExeDevDiscoveryInput {
  bindHost: string;
  port: number;
  token: string;
}

export interface ExeDevDiscoveryDependencies {
  fetch?: ReflectionFetch;
  hostname?: () => string;
  log?: (message: string) => void;
  timeoutMs?: number;
}

function canonicalVmName(value: string) {
  const normalized = value.toLowerCase();
  const suffix = ".exe.xyz";
  const candidate = normalized.endsWith(suffix) ? normalized.slice(0, -suffix.length) : normalized;
  if (candidate.includes(".") || candidate === "localhost" || !VM_NAME.test(candidate)) return;
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function discoverExeDevLaunchUrl(
  input: ExeDevDiscoveryInput,
  dependencies: ExeDevDiscoveryDependencies = {},
) {
  if (input.bindHost !== "0.0.0.0" && input.bindHost !== "::") return;
  if (!Number.isInteger(input.port) || input.port < MIN_PROXY_PORT || input.port > MAX_PROXY_PORT) {
    return;
  }

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const vmName = canonicalVmName((dependencies.hostname ?? systemHostname)());
    if (!vmName) return;

    timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 1_000);
    const response = await (dependencies.fetch ?? globalThis.fetch)(REFLECTION_DEFAULT_PORT_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return;
    const reflection: unknown = await response.json();
    if (
      !isRecord(reflection) ||
      !Number.isInteger(reflection.default_port) ||
      Number(reflection.default_port) < 1 ||
      Number(reflection.default_port) > 65_535
    ) {
      return;
    }

    const url = new URL(`https://${vmName}.exe.xyz/`);
    if (input.port !== reflection.default_port) url.port = String(input.port);
    url.searchParams.set("token", input.token);
    return url.toString();
  } catch {
    return;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function announceExeDevWorkbench(
  input: ExeDevDiscoveryInput,
  dependencies: ExeDevDiscoveryDependencies = {},
) {
  const url = await discoverExeDevLaunchUrl(input, dependencies);
  if (url) {
    (dependencies.log ?? console.log)(`[nano-banana] Workbench (exe.dev): ${url}`);
  }
  return url;
}
