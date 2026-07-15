import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { exportCircularProjectIcon, imageDimensions, validateImageBytes } from "../image-tools";
import {
  type AspectRatio,
  estimateImageCost,
  getModelCapability,
  type ImageSize,
  MODEL_CAPABILITIES,
  validateKnownModelSettings,
} from "../models";
import { packageRoot } from "../paths";
import { loadRecipes, type Recipe, renderRecipe } from "./recipes";

export const MAX_REFERENCE_COUNT = 14;
export const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_REFERENCE_BYTES = 100 * 1024 * 1024;
export const MAX_SUBJECT_LENGTH = 12_000;

export type CandidateStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancel-requested"
  | "interrupted";

export interface ReferenceRecord {
  order: number;
  originalName: string;
  path: string;
  mimeType: string;
  bytes: number;
  sha256: string;
}

export interface ImageRecord {
  path: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

export interface CandidateRecord {
  id: string;
  armId: string;
  variant: number;
  status: CandidateStatus;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  images: ImageRecord[];
  providerText?: string[];
  usage?: Record<string, number>;
  cost?: {
    status: "calculated" | "upper-bound" | "unavailable";
    usd?: number;
    excludesGrounding: boolean;
  };
  modelVersion?: string;
  responseId?: string;
  error?: string;
  cancellation?: {
    requestedAt: string;
    billing: "not-submitted" | "unknown-may-be-charged" | "reported-usage";
  };
}

export interface ArmRecord {
  id: string;
  recipe: Recipe;
  recipeSha256: string;
  renderedPrompt: string;
  promptSha256: string;
  candidates: CandidateRecord[];
}

export interface ExportRecord {
  id: string;
  candidateId: string;
  createdAt: string;
  directory: string;
  raw: ImageRecord;
  production?: ImageRecord;
  manifestSha256?: string;
}

export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";

const SESSION_STATUSES: readonly SessionStatus[] = [
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
];

export interface SessionManifest {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  derivedFromSessionId?: string;
  status: SessionStatus;
  tool: { name: "nano-banana-workbench"; version: string; gitCommit?: string };
  subject: string;
  provider: "nano-banana";
  settings: {
    modelId: string;
    size: ImageSize;
    aspectRatio?: AspectRatio;
    googleSearch: boolean;
    variantsPerRecipe: number;
    callCount: number;
  };
  estimate: {
    status: "estimated" | "unavailable";
    usd?: number;
    excludesGrounding: boolean;
  };
  confirmation: {
    required: boolean;
    acknowledged: boolean;
    reasons: string[];
  };
  references: ReferenceRecord[];
  arms: ArmRecord[];
  selectedCandidateId?: string;
  exports: ExportRecord[];
}

export interface UploadedReference {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface CreateSessionInput {
  subject: string;
  recipeIds: string[];
  modelId: string;
  size: ImageSize;
  aspectRatio?: AspectRatio;
  googleSearch: boolean;
  variantsPerRecipe: number;
  references: UploadedReference[];
  derivedFromSessionId?: string;
  inheritReferences?: boolean;
  confirmationAcknowledged?: boolean;
}

export interface SpendSummary {
  status: "complete" | "upper-bound" | "partial" | "unavailable";
  calculatedUsd?: number;
  upperBoundUsd?: number;
  calculatedCount: number;
  upperBoundCount: number;
  unavailableCount: number;
  unknownMayBeChargedCount: number;
  unknownGroundingChargeCount: number;
}

export class WorkbenchError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionForMime(mimeType: string) {
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpeg",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/svg+xml": ".svg",
    }[mimeType] ?? ".bin"
  );
}

function sanitizeName(name: string) {
  const cleaned = basename(name)
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return cleaned || "reference";
}

function deriveSessionStatus(manifest: SessionManifest): SessionManifest["status"] {
  const candidates = manifest.arms.flatMap((arm) => arm.candidates);
  if (candidates.some((candidate) => candidate.status === "running")) return "running";
  if (candidates.some((candidate) => candidate.status === "queued")) return "queued";
  const succeeded = candidates.filter((candidate) => candidate.status === "succeeded").length;
  if (succeeded === candidates.length) return "completed";
  if (succeeded > 0) return "partial";
  if (candidates.every((candidate) => candidate.status === "cancel-requested")) {
    return "cancelled";
  }
  if (candidates.some((candidate) => candidate.status === "interrupted")) return "interrupted";
  return "failed";
}

async function gitCommit() {
  const process = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], {
    cwd: packageRoot(),
    stdout: "pipe",
    stderr: "ignore",
  });
  if ((await process.exited) !== 0) return;
  return (await new Response(process.stdout).text()).trim() || undefined;
}

export class SessionStore {
  readonly root: string;
  readonly sessionsRoot: string;
  private locks = new Map<string, Promise<void>>();
  private recipes?: Recipe[];
  private toolMetadata?: SessionManifest["tool"];

  constructor(root = join(homedir(), ".nano-banana", "workbench")) {
    this.root = resolve(root);
    this.sessionsRoot = join(this.root, "sessions");
  }

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.assertSafeStoragePath(this.root);
    await this.ensureSafeDirectory(this.sessionsRoot);
    this.recipes = await loadRecipes();
    const packageJson = await Bun.file(join(packageRoot(), "package.json")).json();
    this.toolMetadata = {
      name: "nano-banana-workbench",
      version: String(packageJson.version),
      gitCommit: await gitCommit(),
    };
    await this.recoverInterruptedSessions();
  }

  getRecipes() {
    if (!this.recipes) throw new Error("SessionStore is not initialized.");
    return structuredClone(this.recipes);
  }

  capabilities() {
    return structuredClone(MODEL_CAPABILITIES);
  }

  private safePath(root: string, relativePath: string) {
    const result = resolve(root, relativePath);
    if (result !== root && !result.startsWith(`${root}${sep}`)) {
      throw new WorkbenchError("path_outside_root", "Path escapes workbench storage.");
    }
    return result;
  }

  private async assertSafeStoragePath(path: string, allowMissingLeaf = false) {
    const absolute = this.safePath(this.root, relative(this.root, resolve(path)));
    const rootInfo = await lstat(this.root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new WorkbenchError(
        "unsafe_storage_path",
        "Workbench storage root is not a safe directory.",
      );
    }
    const rootReal = await realpath(this.root);
    let current = this.root;
    const parts = relative(this.root, absolute).split(sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new WorkbenchError(
            "unsafe_storage_path",
            "Symbolic links are not allowed in workbench storage.",
          );
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          allowMissingLeaf &&
          index === parts.length - 1
        ) {
          const parentReal = await realpath(dirname(current));
          if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${sep}`)) {
            throw new WorkbenchError("path_outside_root", "Path escapes workbench storage.");
          }
          return;
        }
        throw error;
      }
    }
    const actual = await realpath(absolute);
    if (actual !== rootReal && !actual.startsWith(`${rootReal}${sep}`)) {
      throw new WorkbenchError("path_outside_root", "Path escapes workbench storage.");
    }
  }

  private async ensureSafeDirectory(path: string) {
    const absolute = this.safePath(this.root, relative(this.root, resolve(path)));
    let current = this.root;
    for (const part of relative(this.root, absolute).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new WorkbenchError("unsafe_storage_path", "Workbench directory path is unsafe.");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(current, { mode: 0o700 }).catch(async (mkdirError) => {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const info = await lstat(current);
          if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new WorkbenchError("unsafe_storage_path", "Workbench directory path is unsafe.");
          }
        });
      }
    }
    await this.assertSafeStoragePath(absolute);
  }

  private async readStorageFile(path: string) {
    await this.assertSafeStoragePath(path);
    return readFile(path);
  }

  async readSessionFile(sessionId: string, relativePath: string) {
    return this.readStorageFile(this.pathInSession(sessionId, relativePath));
  }

  sessionDirectory(sessionId: string) {
    if (!/^\d{4}-\d{2}-\d{2}_[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new WorkbenchError("invalid_session_id", "Invalid session ID.");
    }
    return this.safePath(join(this.sessionsRoot, sessionId.slice(0, 10)), sessionId);
  }

  private manifestPath(sessionId: string) {
    return join(this.sessionDirectory(sessionId), "manifest.json");
  }

  pathInSession(sessionId: string, relativePath: string) {
    return this.safePath(this.sessionDirectory(sessionId), relativePath);
  }

  private async atomicWriteJson(path: string, value: unknown) {
    await this.ensureSafeDirectory(dirname(path));
    await this.assertSafeStoragePath(path, true);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await this.assertSafeStoragePath(temporary);
    await rename(temporary, path);
    await this.assertSafeStoragePath(path);
  }

  private async withLock<T>(sessionId: string, action: () => Promise<T>) {
    const previous = this.locks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.locks.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      void tail.then(() => {
        if (this.locks.get(sessionId) === tail) this.locks.delete(sessionId);
      });
    }
  }

  async readSession(sessionId: string): Promise<SessionManifest> {
    try {
      return JSON.parse(
        (await this.readStorageFile(this.manifestPath(sessionId))).toString("utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkbenchError("session_not_found", "Session not found.", 404);
      }
      throw error;
    }
  }

  async updateSession(
    sessionId: string,
    mutate: (manifest: SessionManifest) => void | Promise<void>,
  ) {
    return this.withLock(sessionId, async () => {
      const manifest = await this.readSession(sessionId);
      await mutate(manifest);
      manifest.status = deriveSessionStatus(manifest);
      manifest.updatedAt = new Date().toISOString();
      await this.atomicWriteJson(this.manifestPath(sessionId), manifest);
      return manifest;
    });
  }

  async createSession(input: CreateSessionInput) {
    if (!this.recipes || !this.toolMetadata) throw new Error("SessionStore is not initialized.");
    if (
      typeof input.googleSearch !== "boolean" ||
      (input.inheritReferences !== undefined && typeof input.inheritReferences !== "boolean") ||
      (input.confirmationAcknowledged !== undefined &&
        typeof input.confirmationAcknowledged !== "boolean")
    ) {
      throw new WorkbenchError("invalid_payload", "Session boolean fields must be booleans.");
    }
    const subject = input.subject.trim();
    if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
      throw new WorkbenchError(
        "invalid_subject",
        `Subject must contain 1-${MAX_SUBJECT_LENGTH} characters.`,
      );
    }
    if (input.recipeIds.length < 1 || input.recipeIds.length > 3) {
      throw new WorkbenchError("invalid_recipes", "Choose one to three recipes.");
    }
    if (new Set(input.recipeIds).size !== input.recipeIds.length) {
      throw new WorkbenchError("invalid_recipes", "Recipe choices must be unique.");
    }
    const recipeLibrary = this.recipes;
    const recipes = input.recipeIds.map((id) => {
      const recipe = recipeLibrary.find((candidate) => candidate.id === id);
      if (!recipe) throw new WorkbenchError("unknown_recipe", `Unknown recipe: ${id}`);
      return recipe;
    });
    if (recipes.length > 1 && recipes.some((recipe) => !recipe.comparable)) {
      throw new WorkbenchError(
        "incomparable_recipe",
        "Custom cannot be included in a style comparison.",
      );
    }
    if (recipes.some((recipe) => recipe.kind === "project-icon") && input.aspectRatio !== "1:1") {
      throw new WorkbenchError(
        "project_icon_requires_square",
        "Folio project-icon recipes require a 1:1 aspect ratio.",
      );
    }
    if (
      !Number.isInteger(input.variantsPerRecipe) ||
      input.variantsPerRecipe < 1 ||
      input.variantsPerRecipe > 8
    ) {
      throw new WorkbenchError("invalid_variants", "Variants per recipe must be 1-8.");
    }
    const model = getModelCapability(input.modelId);
    if (!model) throw new WorkbenchError("unknown_model", "Choose a supported model ID.");
    const settingsError = validateKnownModelSettings(input.modelId, input.size, input.aspectRatio);
    if (settingsError) throw new WorkbenchError("unsupported_settings", settingsError);
    if (input.googleSearch && !model.searchGrounding) {
      throw new WorkbenchError(
        "unsupported_search",
        `${input.modelId} does not support Google Search grounding.`,
      );
    }
    let effectiveReferences = input.references;
    if (input.derivedFromSessionId) {
      const parent = await this.readSession(input.derivedFromSessionId);
      if (input.inheritReferences) {
        effectiveReferences = await Promise.all(
          parent.references.map(async (reference) => ({
            name: reference.originalName,
            mimeType: reference.mimeType,
            bytes: await this.readSessionFile(parent.id, reference.path),
          })),
        );
      }
    }
    if (effectiveReferences.length > MAX_REFERENCE_COUNT) {
      throw new WorkbenchError(
        "too_many_references",
        `At most ${MAX_REFERENCE_COUNT} reference images are allowed.`,
      );
    }
    let totalReferenceBytes = 0;
    await this.ensureSafeDirectory(join(this.root, "validation"));
    for (const reference of effectiveReferences) {
      if (
        !Object.keys({
          "image/png": 1,
          "image/jpeg": 1,
          "image/webp": 1,
          "image/gif": 1,
        }).includes(reference.mimeType)
      ) {
        throw new WorkbenchError(
          "invalid_reference_type",
          "References must be PNG, JPEG, WebP, or GIF.",
        );
      }
      if (!reference.bytes.length || reference.bytes.length > MAX_REFERENCE_BYTES) {
        throw new WorkbenchError(
          "reference_too_large",
          `Each reference must be at most ${MAX_REFERENCE_BYTES / 1024 / 1024} MB.`,
        );
      }
      totalReferenceBytes += reference.bytes.length;
      try {
        await validateImageBytes(
          reference.bytes,
          reference.mimeType,
          join(this.root, "validation"),
        );
      } catch {
        throw new WorkbenchError(
          "invalid_reference_content",
          "Reference image could not be decoded safely.",
        );
      }
    }
    if (totalReferenceBytes > MAX_TOTAL_REFERENCE_BYTES) {
      throw new WorkbenchError("references_too_large", "References exceed the 100 MB total limit.");
    }
    const callCount = recipes.length * input.variantsPerRecipe;
    const perImageEstimate = estimateImageCost(input.modelId, input.size);
    const estimatedUsd = perImageEstimate === undefined ? undefined : perImageEstimate * callCount;
    const reasons = [
      ...(callCount > 8 ? [`${callCount} calls exceeds the 8-call threshold`] : []),
      ...(estimatedUsd !== undefined && estimatedUsd > 1
        ? [`$${estimatedUsd.toFixed(2)} exceeds the $1 estimate threshold`]
        : []),
    ];
    if (reasons.length && input.confirmationAcknowledged !== true) {
      throw new WorkbenchError(
        "confirmation_required",
        "Explicit confirmation is required for this run.",
        409,
        { callCount, estimatedUsd, reasons },
      );
    }

    const now = new Date();
    const timestamp = now.toISOString();
    const id = `${timestamp.slice(0, 10)}_${timestamp.slice(11, 19).replaceAll(":", "")}-${randomUUID().slice(0, 8)}`;
    const directory = this.sessionDirectory(id);
    await this.ensureSafeDirectory(join(directory, "references"));

    try {
      const references: ReferenceRecord[] = [];
      for (const [index, reference] of effectiveReferences.entries()) {
        const extension = extensionForMime(reference.mimeType);
        const relativePath = join(
          "references",
          `${String(index + 1).padStart(3, "0")}${extension}`,
        );
        const referencePath = this.pathInSession(id, relativePath);
        await this.assertSafeStoragePath(referencePath, true);
        await writeFile(referencePath, reference.bytes, { mode: 0o600, flag: "wx" });
        await this.assertSafeStoragePath(referencePath);
        references.push({
          order: index + 1,
          originalName: sanitizeName(reference.name),
          path: relativePath,
          mimeType: reference.mimeType,
          bytes: reference.bytes.length,
          sha256: sha256(reference.bytes),
        });
      }

      const arms: ArmRecord[] = recipes.map((recipe, armIndex) => {
        const snapshot = structuredClone(recipe);
        const renderedPrompt = renderRecipe(snapshot, subject);
        return {
          id: `arm-${armIndex + 1}`,
          recipe: snapshot,
          recipeSha256: sha256(JSON.stringify(snapshot)),
          renderedPrompt,
          promptSha256: sha256(renderedPrompt),
          candidates: Array.from({ length: input.variantsPerRecipe }, (_, variantIndex) => ({
            id: `candidate-${armIndex + 1}-${variantIndex + 1}`,
            armId: `arm-${armIndex + 1}`,
            variant: variantIndex + 1,
            status: "queued" as const,
            queuedAt: timestamp,
            images: [],
          })),
        };
      });

      const manifest: SessionManifest = {
        schemaVersion: 1,
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        derivedFromSessionId: input.derivedFromSessionId,
        status: "queued",
        tool: structuredClone(this.toolMetadata),
        subject,
        provider: "nano-banana",
        settings: {
          modelId: input.modelId,
          size: input.size,
          aspectRatio: input.aspectRatio,
          googleSearch: input.googleSearch,
          variantsPerRecipe: input.variantsPerRecipe,
          callCount,
        },
        estimate: {
          status: estimatedUsd === undefined ? "unavailable" : "estimated",
          usd: estimatedUsd,
          excludesGrounding: input.googleSearch,
        },
        confirmation: {
          required: reasons.length > 0,
          acknowledged: input.confirmationAcknowledged === true,
          reasons,
        },
        references,
        arms,
        exports: [],
      };
      await this.atomicWriteJson(this.manifestPath(id), manifest);
      return manifest;
    } catch (error) {
      await this.assertSafeStoragePath(directory).then(
        () => rm(directory, { recursive: true, force: true }),
        () => undefined,
      );
      throw error;
    }
  }

  orderedCandidates(manifest: SessionManifest) {
    const candidates: CandidateRecord[] = [];
    for (let variant = 1; variant <= manifest.settings.variantsPerRecipe; variant++) {
      for (const arm of manifest.arms) {
        const candidate = arm.candidates.find((item) => item.variant === variant);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  }

  findCandidate(manifest: SessionManifest, candidateId: string) {
    for (const arm of manifest.arms) {
      const candidate = arm.candidates.find((item) => item.id === candidateId);
      if (candidate) return { arm, candidate };
    }
    throw new WorkbenchError("candidate_not_found", "Candidate not found.", 404);
  }

  async saveCandidateImages(
    sessionId: string,
    candidateId: string,
    images: Array<{ bytes: Uint8Array; mimeType: string }>,
  ) {
    const records: ImageRecord[] = [];
    const createdPaths: string[] = [];
    const directory = this.pathInSession(sessionId, join("candidates", candidateId));
    await this.ensureSafeDirectory(directory);
    try {
      for (const [index, image] of images.entries()) {
        const extension = extensionForMime(image.mimeType);
        const relativePath = join(
          "candidates",
          candidateId,
          index === 0 ? `raw${extension}` : `raw-${index + 1}${extension}`,
        );
        const path = this.pathInSession(sessionId, relativePath);
        await this.assertSafeStoragePath(path, true);
        await writeFile(path, image.bytes, { mode: 0o600, flag: "wx" });
        createdPaths.push(path);
        await this.assertSafeStoragePath(path);
        const dimensions = await imageDimensions(path);
        records.push({
          path: relativePath,
          mimeType: image.mimeType,
          bytes: image.bytes.length,
          ...dimensions,
          sha256: sha256(image.bytes),
        });
      }
    } catch (error) {
      await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
      throw error;
    }
    return records;
  }

  async selectCandidate(sessionId: string, candidateId: string | null) {
    return this.updateSession(sessionId, (manifest) => {
      if (candidateId === null) {
        delete manifest.selectedCandidateId;
        return;
      }
      const { candidate } = this.findCandidate(manifest, candidateId);
      if (candidate.status !== "succeeded") {
        throw new WorkbenchError(
          "candidate_not_ready",
          "Only a succeeded candidate can be selected.",
        );
      }
      manifest.selectedCandidateId = candidateId;
    });
  }

  async exportCandidate(sessionId: string, candidateId: string) {
    const manifest = await this.readSession(sessionId);
    const { arm, candidate } = this.findCandidate(manifest, candidateId);
    if (candidate.status !== "succeeded") {
      throw new WorkbenchError(
        "candidate_not_ready",
        "Only a succeeded candidate can be exported.",
      );
    }
    const source = candidate.images[0];
    if (!source) throw new WorkbenchError("missing_image", "Candidate has no image to export.");
    const sourceBytes = await this.readSessionFile(sessionId, source.path);
    const sourceDimensions = await imageDimensions(this.pathInSession(sessionId, source.path));
    if (sha256(sourceBytes) !== source.sha256 || sourceBytes.length !== source.bytes) {
      throw new WorkbenchError(
        "source_changed",
        "Selected candidate bytes no longer match the manifest.",
      );
    }
    if (sourceDimensions.width !== source.width || sourceDimensions.height !== source.height) {
      throw new WorkbenchError(
        "source_changed",
        "Selected candidate dimensions no longer match the manifest.",
      );
    }
    if (arm.recipe.export.type === "folio-icon" && source.width !== source.height) {
      throw new WorkbenchError(
        "project_icon_requires_square",
        "Project-icon export requires a square generated image.",
        409,
      );
    }
    const references = await Promise.all(
      manifest.references.map(async (reference) => {
        const bytes = await this.readSessionFile(sessionId, reference.path);
        if (bytes.length !== reference.bytes || sha256(bytes) !== reference.sha256) {
          throw new WorkbenchError(
            "reference_changed",
            "A reference no longer matches the manifest.",
          );
        }
        return { reference, bytes };
      }),
    );

    const exportId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${candidateId}-${randomUUID().slice(0, 8)}`;
    const relativeDirectory = join("exports", exportId);
    const directory = this.pathInSession(sessionId, relativeDirectory);
    const stageDirectory = this.pathInSession(
      sessionId,
      join("exports", `.${exportId}.${randomUUID()}.tmp`),
    );
    await this.ensureSafeDirectory(dirname(directory));
    await this.assertSafeStoragePath(directory, true);
    await this.ensureSafeDirectory(stageDirectory);

    let renamed = false;
    try {
      const rawExtension = extname(source.path) || extensionForMime(source.mimeType);
      const rawRelativePath = join(relativeDirectory, `raw${rawExtension}`);
      const stagedRawPath = join(stageDirectory, `raw${rawExtension}`);
      await writeFile(stagedRawPath, sourceBytes, { mode: 0o600, flag: "wx" });
      await this.assertSafeStoragePath(stagedRawPath);
      const stagedRawBytes = await this.readStorageFile(stagedRawPath);
      const rawDimensions = await imageDimensions(stagedRawPath);
      const raw: ImageRecord = {
        path: rawRelativePath,
        mimeType: source.mimeType,
        bytes: stagedRawBytes.length,
        ...rawDimensions,
        sha256: sha256(stagedRawBytes),
      };
      if (raw.sha256 !== source.sha256 || raw.bytes !== source.bytes) {
        throw new Error("Raw export is not byte-identical to the selected image.");
      }

      let production: ImageRecord | undefined;
      if (arm.recipe.export.type === "folio-icon") {
        const stagedProductionPath = join(stageDirectory, "production.png");
        await exportCircularProjectIcon(stagedRawPath, stagedProductionPath);
        await this.assertSafeStoragePath(stagedProductionPath);
        const bytes = await this.readStorageFile(stagedProductionPath);
        const dimensions = await imageDimensions(stagedProductionPath);
        if (dimensions.width !== 384 || dimensions.height !== 384) {
          throw new Error("Production export has unexpected dimensions.");
        }
        production = {
          path: join(relativeDirectory, "production.png"),
          mimeType: "image/png",
          bytes: bytes.length,
          ...dimensions,
          sha256: sha256(bytes),
        };
      }

      if (references.length) await this.ensureSafeDirectory(join(stageDirectory, "references"));
      for (const { reference, bytes } of references) {
        const destination = join(stageDirectory, "references", basename(reference.path));
        await this.assertSafeStoragePath(destination, true);
        await writeFile(destination, bytes, { mode: 0o600, flag: "wx" });
        const copied = await this.readStorageFile(destination);
        if (copied.length !== reference.bytes || sha256(copied) !== reference.sha256) {
          throw new Error("Exported reference does not match its manifest hash.");
        }
      }

      const record: ExportRecord = {
        id: exportId,
        candidateId,
        createdAt: new Date().toISOString(),
        directory: relativeDirectory,
        raw,
        production,
      };
      const bundleManifest = structuredClone(manifest);
      bundleManifest.exports.push(record);
      bundleManifest.updatedAt = new Date().toISOString();
      const bundleManifestPath = join(stageDirectory, "manifest.json");
      await this.atomicWriteJson(bundleManifestPath, bundleManifest);
      const manifestBytes = await this.readStorageFile(bundleManifestPath);
      const parsedBundle = JSON.parse(manifestBytes.toString("utf8")) as SessionManifest;
      if (parsedBundle.id !== sessionId || parsedBundle.exports.at(-1)?.id !== exportId) {
        throw new Error("Export manifest verification failed.");
      }
      record.manifestSha256 = sha256(manifestBytes);

      await rename(stageDirectory, directory);
      renamed = true;
      await this.assertSafeStoragePath(directory);
      let final: SessionManifest;
      try {
        final = await this.updateSession(sessionId, (latest) => {
          const latestCandidate = this.findCandidate(latest, candidateId).candidate;
          if (
            latestCandidate.status !== "succeeded" ||
            latestCandidate.images[0]?.sha256 !== source.sha256
          ) {
            throw new WorkbenchError("candidate_changed", "Candidate changed during export.", 409);
          }
          latest.exports.push(structuredClone(record));
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      const savedExport = final.exports.find((item) => item.id === record.id);
      if (!savedExport) throw new Error("Export record disappeared after commit.");
      return { manifest: final, export: savedExport };
    } finally {
      if (!renamed) {
        await this.assertSafeStoragePath(stageDirectory).then(
          () => rm(stageDirectory, { recursive: true, force: true }),
          () => undefined,
        );
      }
    }
  }

  async candidateImagePath(sessionId: string, candidateId: string, imageIndex: number) {
    const manifest = await this.readSession(sessionId);
    const { candidate } = this.findCandidate(manifest, candidateId);
    const image = candidate.images[imageIndex];
    if (!image) throw new WorkbenchError("image_not_found", "Candidate image not found.", 404);
    const path = this.pathInSession(sessionId, image.path);
    await this.assertSafeStoragePath(path);
    return { path, image };
  }

  private async readStoredSessions(skipUnreadable = false) {
    const sessions: SessionManifest[] = [];
    let dateDirectories: string[] = [];
    try {
      await this.assertSafeStoragePath(this.sessionsRoot);
      dateDirectories = await readdir(this.sessionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof WorkbenchError) throw error;
      throw new WorkbenchError("history_read_failed", "Stored history could not be read.", 500);
    }
    for (const date of dateDirectories.sort().reverse()) {
      let entries: string[] = [];
      try {
        const dateDirectory = this.safePath(this.sessionsRoot, date);
        await this.assertSafeStoragePath(dateDirectory);
        entries = await readdir(dateDirectory);
      } catch (error) {
        if (error instanceof WorkbenchError) throw error;
        if (skipUnreadable) continue;
        throw new WorkbenchError("history_read_failed", "Stored history could not be read.", 500);
      }
      for (const id of entries.sort().reverse()) {
        try {
          if (id.slice(0, 10) !== date) throw new Error("Session directory date mismatch.");
          const manifest = await this.readSession(id);
          if (
            manifest.schemaVersion !== 1 ||
            manifest.id !== id ||
            typeof manifest.createdAt !== "string" ||
            typeof manifest.updatedAt !== "string" ||
            !SESSION_STATUSES.includes(manifest.status) ||
            typeof manifest.subject !== "string" ||
            typeof manifest.settings !== "object" ||
            manifest.settings === null ||
            typeof manifest.settings.googleSearch !== "boolean" ||
            typeof manifest.estimate !== "object" ||
            manifest.estimate === null ||
            typeof manifest.estimate.excludesGrounding !== "boolean" ||
            manifest.estimate.excludesGrounding !== manifest.settings.googleSearch ||
            !Array.isArray(manifest.arms) ||
            manifest.arms.some(
              (arm) =>
                typeof arm?.recipe?.name !== "string" ||
                !Array.isArray(arm.candidates) ||
                arm.candidates.some(
                  (candidate) =>
                    typeof candidate !== "object" ||
                    candidate === null ||
                    !Array.isArray(candidate.images) ||
                    (candidate.cost !== undefined &&
                      (typeof candidate.cost !== "object" ||
                        typeof candidate.cost.excludesGrounding !== "boolean" ||
                        candidate.cost.excludesGrounding !== manifest.settings.googleSearch ||
                        (candidate.cost.usd !== undefined &&
                          !Number.isFinite(candidate.cost.usd)))),
                ),
            )
          ) {
            throw new Error("Invalid session manifest.");
          }
          sessions.push(manifest);
        } catch (error) {
          if (
            error instanceof WorkbenchError &&
            ["path_outside_root", "unsafe_storage_path"].includes(error.code)
          ) {
            throw error;
          }
          if (skipUnreadable) continue;
          throw new WorkbenchError("history_read_failed", "Stored history could not be read.", 500);
        }
      }
    }
    return sessions;
  }

  async listHistory() {
    const sessions = await this.readStoredSessions();
    return sessions.map((manifest) => {
      const candidates = manifest.arms.flatMap((arm) => arm.candidates);
      let calculatedUsd = 0;
      let upperBoundUsd = 0;
      let calculatedCount = 0;
      let upperBoundCount = 0;
      let unavailableCount = 0;
      let unknownMayBeChargedCount = 0;
      let unknownGroundingChargeCount = 0;
      for (const candidate of candidates) {
        if (candidate.cost?.excludesGrounding) unknownGroundingChargeCount++;
        if (candidate.cost?.status === "calculated" && candidate.cost.usd !== undefined) {
          calculatedUsd += candidate.cost.usd;
          calculatedCount++;
        } else if (candidate.cost?.status === "upper-bound" && candidate.cost.usd !== undefined) {
          upperBoundUsd += candidate.cost.usd;
          upperBoundCount++;
        } else if (candidate.cancellation?.billing === "unknown-may-be-charged") {
          unknownMayBeChargedCount++;
        } else if (candidate.cancellation?.billing !== "not-submitted") {
          unavailableCount++;
        }
      }
      const hasKnownCost = calculatedCount + upperBoundCount > 0;
      const hasUnknownCost =
        unavailableCount + unknownMayBeChargedCount + unknownGroundingChargeCount > 0;
      const spend: SpendSummary = {
        status: hasUnknownCost
          ? hasKnownCost
            ? "partial"
            : "unavailable"
          : upperBoundCount
            ? "upper-bound"
            : "complete",
        calculatedUsd: calculatedCount ? calculatedUsd : undefined,
        upperBoundUsd: upperBoundCount ? upperBoundUsd : undefined,
        calculatedCount,
        upperBoundCount,
        unavailableCount,
        unknownMayBeChargedCount,
        unknownGroundingChargeCount,
      };
      return {
        id: manifest.id,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        status: manifest.status,
        subject: manifest.subject,
        recipes: manifest.arms.map((arm) => arm.recipe.name),
        settings: manifest.settings,
        estimate: manifest.estimate,
        generatedImageCount: candidates.reduce(
          (sum, candidate) =>
            sum + (candidate.status === "succeeded" ? candidate.images.length : 0),
          0,
        ),
        spend,
        selectedCandidateId: manifest.selectedCandidateId,
      };
    });
  }

  private async countPhysicalSessions() {
    await this.assertSafeStoragePath(this.sessionsRoot, true);
    let dateDirectories: string[];
    try {
      dateDirectories = await readdir(this.sessionsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let count = 0;
    for (const date of dateDirectories) {
      const dateDirectory = this.safePath(this.sessionsRoot, date);
      await this.assertSafeStoragePath(dateDirectory);
      const entries = await readdir(dateDirectory);
      for (const entry of entries) {
        await this.assertSafeStoragePath(this.safePath(dateDirectory, entry));
        count++;
      }
    }
    return count;
  }

  async clearAllSessions() {
    try {
      const cleared = await this.countPhysicalSessions();
      await rm(this.sessionsRoot, { recursive: true, force: true });
      await this.ensureSafeDirectory(this.sessionsRoot);
      return { cleared };
    } catch (error) {
      if (
        error instanceof WorkbenchError &&
        ["path_outside_root", "unsafe_storage_path"].includes(error.code)
      ) {
        throw error;
      }
      throw new WorkbenchError("history_clear_failed", "Failed to clear workbench history.", 500, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recoverInterruptedSessions() {
    for (const manifest of await this.readStoredSessions(true)) {
      if (
        !manifest.arms.some((arm) =>
          arm.candidates.some((candidate) => ["queued", "running"].includes(candidate.status)),
        )
      ) {
        continue;
      }
      await this.updateSession(manifest.id, (latest) => {
        for (const candidate of latest.arms.flatMap((arm) => arm.candidates)) {
          if (candidate.status === "running" || candidate.status === "queued") {
            const wasRunning = candidate.status === "running";
            candidate.status = "interrupted";
            candidate.completedAt = new Date().toISOString();
            candidate.error = wasRunning
              ? "Workbench stopped before this call completed."
              : "Workbench stopped before this call was submitted.";
            if (wasRunning) {
              candidate.cancellation = {
                requestedAt: candidate.completedAt,
                billing: "unknown-may-be-charged",
              };
            }
          }
        }
      });
    }
  }
}

export function hashForTest(value: Uint8Array | string) {
  return sha256(value);
}
