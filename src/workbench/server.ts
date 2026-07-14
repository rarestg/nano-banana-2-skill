import { timingSafeEqual, randomBytes } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join, sep } from "node:path";

import { resolveApiKey } from "../env";
import { detectImageMimeType } from "../image-tools";
import { VALID_ASPECTS, VALID_SIZES, type AspectRatio, type ImageSize } from "../models";
import { packageRoot } from "../paths";
import { JobQueue, mockGenerationRunner, type GenerationRunner } from "./jobs";
import {
  MAX_REFERENCE_BYTES,
  MAX_REFERENCE_COUNT,
  MAX_SUBJECT_LENGTH,
  MAX_TOTAL_REFERENCE_BYTES,
  SessionStore,
  WorkbenchError,
  type CreateSessionInput,
  type UploadedReference,
} from "./store";

const webRoot = join(packageRoot(), "web");
const MAX_REQUEST_BYTES = MAX_TOTAL_REFERENCE_BYTES + 1024 * 1024;

export interface WorkbenchOptions {
  host?: string;
  port?: number;
  storageRoot?: string;
  runner?: GenerationRunner;
  mock?: boolean;
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function secretsEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function cookieValue(request: Request, key: string) {
  for (const pair of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === key) return decodeURIComponent(value.join("="));
  }
}

function hostnameFromHeader(value: string | null) {
  if (!value) return;
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return;
  }
}

function isLoopback(value: string) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function allowedHost(requestHost: string | null, bindHost: string) {
  const requestHostname = hostnameFromHeader(requestHost);
  if (!requestHostname) return false;
  if (isLoopback(requestHostname)) return true;
  if (requestHostname === bindHost.toLowerCase() || requestHostname === hostname().toLowerCase()) {
    return true;
  }
  return (bindHost === "0.0.0.0" || bindHost === "::") && requestHostname.endsWith(".exe.xyz");
}

function forwardedPublicHost(request: Request, bindHost: string) {
  if (bindHost !== "0.0.0.0" && bindHost !== "::") return;
  const value = request.headers.get("x-forwarded-host")?.split(",")[0].trim();
  const forwardedHostname = hostnameFromHeader(value ?? null);
  if (value && forwardedHostname?.endsWith(".exe.xyz")) return value;
}

function expectedOrigin(request: Request, bindHost: string) {
  const forwardedHost = forwardedPublicHost(request, bindHost);
  const host = forwardedHost ?? request.headers.get("host");
  if (!host) return;
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const trustedForwarded =
    forwardedHost && (forwarded === "http" || forwarded === "https") ? forwarded : undefined;
  const protocol = trustedForwarded ?? new URL(request.url).protocol.slice(0, -1);
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return;
  }
}

function requireOrigin(request: Request, bindHost: string) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  const expected = expectedOrigin(request, bindHost);
  if (!origin || !expected) return false;
  try {
    return new URL(origin).origin === expected;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new WorkbenchError("unknown_field", `${label} contains unknown field: ${unknown[0]}`);
  }
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== "string") {
    throw new WorkbenchError("invalid_payload", `${name} must be a string.`);
  }
  return value;
}

function optionalString(value: unknown, name: string) {
  if (value === undefined) return;
  return requiredString(value, name);
}

function optionalBoolean(value: unknown, name: string) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    throw new WorkbenchError("invalid_payload", `${name} must be a boolean.`);
  }
  return value;
}

export function parseCreateSessionPayload(value: unknown): Omit<CreateSessionInput, "references"> {
  if (!isRecord(value)) {
    throw new WorkbenchError("invalid_payload", "Session payload must be an object.");
  }
  exactKeys(
    value,
    [
      "subject",
      "recipeIds",
      "modelId",
      "size",
      "aspectRatio",
      "googleSearch",
      "variantsPerRecipe",
      "derivedFromSessionId",
      "inheritReferences",
      "confirmationAcknowledged",
    ],
    "Session payload",
  );
  if (!Array.isArray(value.recipeIds) || value.recipeIds.some((id) => typeof id !== "string")) {
    throw new WorkbenchError("invalid_payload", "recipeIds must be an array of strings.");
  }
  if (!VALID_SIZES.includes(value.size as ImageSize)) {
    throw new WorkbenchError("invalid_payload", "size must be a supported resolution.");
  }
  if (
    value.aspectRatio !== undefined &&
    !VALID_ASPECTS.includes(value.aspectRatio as AspectRatio)
  ) {
    throw new WorkbenchError("invalid_payload", "aspectRatio must be a supported ratio.");
  }
  if (typeof value.googleSearch !== "boolean") {
    throw new WorkbenchError("invalid_payload", "googleSearch must be a boolean.");
  }
  if (!Number.isInteger(value.variantsPerRecipe)) {
    throw new WorkbenchError("invalid_payload", "variantsPerRecipe must be an integer.");
  }
  return {
    subject: requiredString(value.subject, "subject"),
    recipeIds: value.recipeIds,
    modelId: requiredString(value.modelId, "modelId"),
    size: value.size as ImageSize,
    aspectRatio: value.aspectRatio as AspectRatio | undefined,
    googleSearch: value.googleSearch,
    variantsPerRecipe: value.variantsPerRecipe as number,
    derivedFromSessionId: optionalString(value.derivedFromSessionId, "derivedFromSessionId"),
    inheritReferences: optionalBoolean(value.inheritReferences, "inheritReferences"),
    confirmationAcknowledged: optionalBoolean(
      value.confirmationAcknowledged,
      "confirmationAcknowledged",
    ),
  };
}

async function requestJsonRecord(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json")) {
    throw new WorkbenchError("invalid_content_type", "Expected application/json.");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new WorkbenchError("invalid_json", "Request body is not valid JSON.");
  }
  if (!isRecord(value)) throw new WorkbenchError("invalid_json", "JSON body must be an object.");
  return value;
}

export function validateUploadContentLength(request: Request) {
  if (request.headers.has("transfer-encoding")) {
    throw new WorkbenchError(
      "content_length_required",
      "Chunked uploads are not accepted; Content-Length is required.",
      411,
    );
  }
  const header = request.headers.get("content-length");
  if (!header || !/^\d+$/.test(header)) {
    throw new WorkbenchError(
      "content_length_required",
      "Content-Length is required for uploads.",
      411,
    );
  }
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > MAX_REQUEST_BYTES) {
    throw new WorkbenchError("request_too_large", "Request exceeds the upload limit.", 413);
  }
}

function cookie(token: string, request: Request, bindHost: string) {
  return `nano_banana_workbench=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${expectedOrigin(request, bindHost)?.startsWith("https:") ? "; Secure" : ""}`;
}

function storageDisplayRoot(root: string) {
  const home = homedir();
  return root === home || root.startsWith(`${home}${sep}`) ? `~${root.slice(home.length)}` : root;
}

export async function startWorkbench(options: WorkbenchOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4173;
  const token = randomBytes(24).toString("base64url");
  const store = new SessionStore(options.storageRoot);
  await store.initialize();

  const mock = options.mock ?? process.env.NANO_BANANA_WORKBENCH_MOCK === "1";
  const apiKey = mock || options.runner ? "mock-workbench-key" : resolveApiKey().value;
  const runner = options.runner ?? (mock ? mockGenerationRunner : undefined);
  const queue = apiKey ? new JobQueue(store, apiKey, runner) : undefined;

  const server = Bun.serve({
    hostname: host,
    port,
    maxRequestBodySize: MAX_REQUEST_BYTES,
    async fetch(request) {
      const url = new URL(request.url);
      const launchToken =
        request.method === "GET" && url.pathname === "/"
          ? url.searchParams.get("token")
          : undefined;
      const presentedToken =
        request.headers.get("x-workbench-token") ??
        launchToken ??
        cookieValue(request, "nano_banana_workbench");

      const effectiveHost = forwardedPublicHost(request, host) ?? request.headers.get("host");
      if (!allowedHost(effectiveHost, host)) {
        return json({ error: { code: "invalid_host", message: "Host is not allowed." } }, 403);
      }
      if (!presentedToken || !secretsEqual(token, presentedToken)) {
        return json({ error: { code: "unauthorized", message: "Launch token is required." } }, 401);
      }
      if (!requireOrigin(request, host)) {
        return json({ error: { code: "invalid_origin", message: "Origin is not allowed." } }, 403);
      }

      try {
        if (request.method === "GET" && url.pathname === "/") {
          if (url.searchParams.has("token")) {
            return new Response(null, {
              status: 303,
              headers: {
                Location: "/",
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "Set-Cookie": cookie(token, request, host),
              },
            });
          }
          const html = await Bun.file(join(webRoot, "index.html")).text();
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Security-Policy":
                "default-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
              "Set-Cookie": cookie(token, request, host),
            },
          });
        }

        if (request.method === "GET" && ["/app.js", "/styles.css"].includes(url.pathname)) {
          const path = join(webRoot, url.pathname.slice(1));
          return new Response(Bun.file(path), {
            headers: {
              "Content-Type": url.pathname.endsWith(".js")
                ? "text/javascript; charset=utf-8"
                : "text/css; charset=utf-8",
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        if (request.method === "GET" && url.pathname === "/api/bootstrap") {
          return json({
            keyConfigured: Boolean(apiKey),
            mock,
            storageDisplayRoot: storageDisplayRoot(store.root),
            recipes: store.getRecipes(),
            models: store.capabilities(),
            defaults: {
              recipeIds: ["folio-geometric-isometric"],
              modelId: "gemini-3.1-flash-image",
              size: "512",
              aspectRatio: "1:1",
              googleSearch: false,
              variantsPerRecipe: 4,
            },
            limits: {
              maxReferenceCount: MAX_REFERENCE_COUNT,
              maxReferenceBytes: MAX_REFERENCE_BYTES,
              maxTotalReferenceBytes: MAX_TOTAL_REFERENCE_BYTES,
              maxSubjectLength: MAX_SUBJECT_LENGTH,
              confirmationCallsAbove: 8,
              confirmationUsdAbove: 1,
            },
            queue: queue?.snapshot() ?? { pending: 0, active: 0, concurrency: 2 },
          });
        }

        if (request.method === "GET" && url.pathname === "/api/history") {
          return json({ sessions: await store.listHistory() });
        }

        const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (request.method === "GET" && sessionMatch) {
          return json({ session: await store.readSession(sessionMatch[1]) });
        }

        if (request.method === "POST" && url.pathname === "/api/sessions") {
          if (!queue) {
            throw new WorkbenchError(
              "api_key_missing",
              "Configure GEMINI_API_KEY before generating.",
              409,
            );
          }
          const type = request.headers.get("content-type") ?? "";
          if (!type.startsWith("multipart/form-data;")) {
            throw new WorkbenchError("invalid_content_type", "Expected multipart/form-data.");
          }
          validateUploadContentLength(request);
          const form = await request.formData();
          const unknownFields = [...new Set([...form.keys()])].filter(
            (key) => key !== "payload" && key !== "references",
          );
          if (unknownFields.length) {
            throw new WorkbenchError(
              "unknown_field",
              `Multipart form contains unknown field: ${unknownFields[0]}`,
            );
          }
          const payloadValues = form.getAll("payload");
          if (payloadValues.length !== 1 || typeof payloadValues[0] !== "string") {
            throw new WorkbenchError("missing_payload", "Session payload is required.");
          }
          let parsedPayload: unknown;
          try {
            parsedPayload = JSON.parse(payloadValues[0]);
          } catch {
            throw new WorkbenchError("invalid_payload", "Session payload is not valid JSON.");
          }
          const payload = parseCreateSessionPayload(parsedPayload);
          const values = form.getAll("references");
          if (values.length > MAX_REFERENCE_COUNT) {
            throw new WorkbenchError(
              "too_many_references",
              `At most ${MAX_REFERENCE_COUNT} references are allowed.`,
            );
          }
          let totalBytes = 0;
          for (const value of values) {
            if (!(value instanceof File)) {
              throw new WorkbenchError("invalid_reference", "Reference upload is not a file.");
            }
            if (!value.size || value.size > MAX_REFERENCE_BYTES) {
              throw new WorkbenchError(
                "reference_too_large",
                "A reference exceeds the per-file limit.",
              );
            }
            totalBytes += value.size;
          }
          if (totalBytes > MAX_TOTAL_REFERENCE_BYTES) {
            throw new WorkbenchError("references_too_large", "References exceed the total limit.");
          }
          const references: UploadedReference[] = [];
          for (const value of values) {
            if (!(value instanceof File)) {
              throw new WorkbenchError("invalid_reference", "Reference upload is not a file.");
            }
            const bytes = new Uint8Array(await value.arrayBuffer());
            const detectedType = detectImageMimeType(bytes);
            if (!detectedType || detectedType !== value.type) {
              throw new WorkbenchError(
                "invalid_reference_type",
                "Reference content does not match its declared PNG, JPEG, WebP, or GIF type.",
              );
            }
            references.push({
              name: value.name,
              mimeType: detectedType,
              bytes,
            });
          }
          const session = await store.createSession({ ...payload, references });
          await queue.enqueueSession(session.id);
          return json({ session }, 201);
        }

        const actionMatch = url.pathname.match(
          /^\/api\/sessions\/([^/]+)\/(cancel|select|export)$/,
        );
        if (request.method === "POST" && actionMatch) {
          const [, sessionId, action] = actionMatch;
          if (action === "cancel") {
            if (!queue) throw new WorkbenchError("queue_unavailable", "Queue is unavailable.", 409);
            return json({ session: await queue.cancelSession(sessionId) });
          }
          const body = await requestJsonRecord(request);
          exactKeys(body, ["candidateId"], "Action body");
          const candidateId = requiredString(body.candidateId, "candidateId");
          if (!candidateId)
            throw new WorkbenchError("missing_candidate", "candidateId is required.");
          if (action === "select") {
            return json({ session: await store.selectCandidate(sessionId, candidateId) });
          }
          const result = await store.exportCandidate(sessionId, candidateId);
          return json(result);
        }

        const imageMatch = url.pathname.match(
          /^\/api\/sessions\/([^/]+)\/candidates\/([^/]+)\/images\/(\d+)$/,
        );
        if (request.method === "GET" && imageMatch) {
          const imageIndex = Number(imageMatch[3]);
          if (!Number.isSafeInteger(imageIndex)) {
            throw new WorkbenchError("image_not_found", "Image index is invalid.", 404);
          }
          const result = await store.candidateImagePath(imageMatch[1], imageMatch[2], imageIndex);
          return new Response(Bun.file(result.path), {
            headers: {
              "Content-Type": result.image.mimeType,
              "Cache-Control": "private, no-store",
              "Content-Security-Policy": "default-src 'none'; sandbox",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        return json({ error: { code: "not_found", message: "Not found." } }, 404);
      } catch (error) {
        if (error instanceof WorkbenchError) {
          return json(
            {
              error: {
                code: error.code,
                message: error.message,
                details: error.details,
              },
            },
            error.status,
          );
        }
        return json(
          { error: { code: "internal_error", message: "Workbench request failed." } },
          500,
        );
      }
    },
  });

  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${server.port}/?token=${token}`;
  console.log(`\x1b[36m[nano-banana]\x1b[0m Workbench: ${url}`);
  console.log(
    `\x1b[90mAPI key: ${apiKey ? "configured" : "not configured"}${mock ? " (mock mode)" : ""}\x1b[0m`,
  );
  if (host === "0.0.0.0" || host === "::") {
    console.log(
      `\x1b[90mNon-loopback mode: use the private exe.dev proxy and open the one-time launch URL.\x1b[0m`,
    );
  }

  return { server, token, url, store, queue, mock };
}
