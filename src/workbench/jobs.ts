import { generateImage, type GenerateRequest, type GenerationResult } from "../generate";
import type { SessionStore } from "./store";

export type GenerationRunner = (request: GenerateRequest) => Promise<GenerationResult>;

interface QueuedJob {
  sessionId: string;
  candidateId: string;
}

export class JobQueue {
  private pending: QueuedJob[] = [];
  private active = new Map<string, AbortController>();
  private scheduled = new Set<string>();
  private idleWaiters = new Set<() => void>();

  constructor(
    private store: SessionStore,
    private apiKey: string,
    private runner: GenerationRunner = generateImage,
    private concurrency = 2,
  ) {}

  private key(job: QueuedJob) {
    return `${job.sessionId}:${job.candidateId}`;
  }

  async enqueueSession(sessionId: string) {
    const manifest = await this.store.readSession(sessionId);
    for (const candidate of this.store.orderedCandidates(manifest)) {
      const job = { sessionId, candidateId: candidate.id };
      const key = this.key(job);
      if (candidate.status === "queued" && !this.scheduled.has(key)) {
        this.pending.push(job);
        this.scheduled.add(key);
      }
    }
    this.pump();
  }

  snapshot() {
    return {
      pending: this.pending.length,
      active: this.active.size,
      concurrency: this.concurrency,
    };
  }

  async cancelSession(sessionId: string) {
    const now = new Date().toISOString();
    const queued = new Set(
      this.pending.filter((job) => job.sessionId === sessionId).map((job) => job.candidateId),
    );
    this.pending = this.pending.filter((job) => job.sessionId !== sessionId);
    for (const candidateId of queued) {
      this.scheduled.delete(`${sessionId}:${candidateId}`);
    }

    const active = new Set<string>();
    for (const [key, controller] of this.active) {
      if (key.startsWith(`${sessionId}:`)) {
        active.add(key.slice(sessionId.length + 1));
        controller.abort();
      }
    }

    const manifest = await this.store.updateSession(sessionId, (latest) => {
      for (const candidate of latest.arms.flatMap((arm) => arm.candidates)) {
        if (queued.has(candidate.id) && candidate.status === "queued") {
          candidate.status = "cancel-requested";
          candidate.completedAt = now;
          candidate.cancellation = { requestedAt: now, billing: "not-submitted" };
        } else if (active.has(candidate.id) && candidate.status === "running") {
          candidate.status = "cancel-requested";
          candidate.cancellation = {
            requestedAt: now,
            billing: "unknown-may-be-charged",
          };
        }
      }
    });
    this.resolveIdleIfNeeded();
    return manifest;
  }

  waitForIdle() {
    if (!this.pending.length && !this.active.size) return Promise.resolve();
    return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private resolveIdleIfNeeded() {
    if (this.pending.length || this.active.size) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private pump() {
    while (this.active.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      if (!job) break;
      const key = this.key(job);
      const controller = new AbortController();
      this.active.set(key, controller);
      void this.run(job, controller)
        .catch(() => undefined)
        .finally(() => {
          this.active.delete(key);
          this.scheduled.delete(key);
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
    this.resolveIdleIfNeeded();
  }

  private redactError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message
      .replaceAll(this.apiKey, "[redacted]")
      .replace(/([?&](?:key|api_key)=)[^&\s]+/gi, "$1[redacted]")
      .slice(0, 2_000);
  }

  private async run(job: QueuedJob, controller: AbortController) {
    let manifest = await this.store.readSession(job.sessionId);
    let found = this.store.findCandidate(manifest, job.candidateId);
    if (found.candidate.status !== "queued") return;

    const startedAt = new Date().toISOString();
    manifest = await this.store.updateSession(job.sessionId, (latest) => {
      const { candidate } = this.store.findCandidate(latest, job.candidateId);
      if (candidate.status !== "queued") return;
      candidate.status = "running";
      candidate.startedAt = startedAt;
    });
    found = this.store.findCandidate(manifest, job.candidateId);
    if (found.candidate.status !== "running") return;

    try {
      const references = await Promise.all(
        manifest.references.map(async (reference) => ({
          bytes: await this.store.readSessionFile(job.sessionId, reference.path),
          mimeType: reference.mimeType,
        })),
      );
      const result = await this.runner({
        apiKey: this.apiKey,
        prompt: found.arm.renderedPrompt,
        references,
        modelId: manifest.settings.modelId,
        size: manifest.settings.size,
        aspectRatio: manifest.settings.aspectRatio,
        googleSearch: manifest.settings.googleSearch,
        abortSignal: controller.signal,
      });
      const beforeSave = this.store.findCandidate(
        await this.store.readSession(job.sessionId),
        job.candidateId,
      ).candidate;
      if (beforeSave.status !== "running" && beforeSave.status !== "cancel-requested") return;
      const images = await this.store.saveCandidateImages(
        job.sessionId,
        job.candidateId,
        result.images,
      );
      await this.store.updateSession(job.sessionId, (latest) => {
        const { candidate } = this.store.findCandidate(latest, job.candidateId);
        if (candidate.status !== "running" && candidate.status !== "cancel-requested") return;
        candidate.completedAt = new Date().toISOString();
        candidate.images = images;
        candidate.providerText = result.text;
        candidate.usage = result.usage ? { ...result.usage } : undefined;
        candidate.cost = result.cost;
        candidate.modelVersion = result.modelVersion;
        candidate.responseId = result.responseId;
        if (candidate.cancellation && result.usage) {
          candidate.cancellation.billing = "reported-usage";
        }
        if (images.length) {
          candidate.status = "succeeded";
          delete candidate.error;
        } else {
          if (candidate.status !== "cancel-requested") candidate.status = "failed";
          candidate.error = "Provider returned no image.";
        }
      });
    } catch (error) {
      const aborted = controller.signal.aborted;
      await this.store.updateSession(job.sessionId, (latest) => {
        const { candidate } = this.store.findCandidate(latest, job.candidateId);
        if (candidate.status !== "running" && candidate.status !== "cancel-requested") return;
        candidate.completedAt = new Date().toISOString();
        if (aborted) {
          candidate.status = "cancel-requested";
          candidate.error = "Generation stopped locally after cancellation was requested.";
          candidate.cancellation ??= {
            requestedAt: candidate.completedAt,
            billing: "unknown-may-be-charged",
          };
        } else {
          candidate.status = "failed";
          candidate.error = this.redactError(error);
        }
      });
    }
  }
}

function escapeXml(value: string) {
  const replacements: Record<string, string> = {
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  };
  return value.replace(/[<>&'"]/g, (character) => replacements[character] ?? "");
}

export const mockGenerationRunner: GenerationRunner = async (request) => {
  if (request.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, 80);
    request.abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
  const size = request.size === "512" ? 512 : 1024;
  const label = escapeXml(request.prompt.slice(0, 42));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" fill="#FAFAFA"/><circle cx="${size / 2}" cy="${size / 2}" r="${size * 0.3}" fill="#CBFBF1"/><path d="M${size * 0.3} ${size * 0.58} L${size * 0.5} ${size * 0.26} L${size * 0.7} ${size * 0.58} Z" fill="#00BBA7"/><rect x="${size * 0.4}" y="${size * 0.5}" width="${size * 0.2}" height="${size * 0.2}" rx="${size * 0.02}" fill="#18181B"/><text x="${size / 2}" y="${size * 0.88}" text-anchor="middle" font-family="sans-serif" font-size="${size * 0.025}" fill="#71717B">${label}</text></svg>`;
  return {
    images: [{ bytes: new TextEncoder().encode(svg), mimeType: "image/svg+xml" }],
    text: ["Mock workbench result"],
    usage: {
      promptTokens: 0,
      candidateTokens: 0,
      thoughtTokens: 0,
      imageOutputTokens: 0,
      textOutputTokens: 0,
      unclassifiedOutputTokens: 0,
      totalTokens: 0,
    },
    cost: { status: "calculated", usd: 0, excludesGrounding: request.googleSearch ?? false },
    modelVersion: "mock",
    responseId: "mock",
  };
};
