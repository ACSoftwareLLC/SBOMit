import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runAudit, type AuditEvent } from "./run-audit";
import type { AuditResult } from "./audit";

const mockResolveLibrary = vi.fn();
const mockResolveCodebase = vi.fn();
const mockComputeCacheKey = vi.fn();
const mockRunLibraryAudit = vi.fn();
const mockGetLlmConfig = vi.fn();
const mockSaveAuditReport = vi.fn();
const mockGetDb = vi.fn();
const mockDbFirst = vi.fn();
const mockGetCachedAuditReport = vi.fn();
const mockEnrichLibrary = vi.fn();

vi.mock("./audit", () => {
  return {
    resolveLibrary: (...args: unknown[]) => mockResolveLibrary(...args),
    resolveCodebase: (...args: unknown[]) => mockResolveCodebase(...args),
    computeCacheKey: (...args: unknown[]) => mockComputeCacheKey(...args),
    postProcessAuditResult: (result: AuditResult) => result,
  };
});

vi.mock("./llm", () => {
  return {
    runLibraryAudit: (...args: unknown[]) => mockRunLibraryAudit(...args),
    getLlmConfig: () => mockGetLlmConfig(),
    getLlmConfigForProviderModel: (_provider: string, model: string) => ({
      provider: "openai" as const,
      apiKey: "test",
      model,
    }),
    mergeAuditResults: () =>
      Promise.resolve({
        result: baseResult,
        exclusions: [],
        interaction: baseInteraction,
      }),
  };
});

vi.mock("./db", () => {
  return {
    getDb: () => mockGetDb(),
    saveAuditReport: (...args: unknown[]) => mockSaveAuditReport(...args),
  };
});

vi.mock("./cache", () => {
  return {
    getCachedAuditReport: (...args: unknown[]) => mockGetCachedAuditReport(...args),
  };
});

vi.mock("./signals", () => {
  return {
    enrichLibrary: (...args: unknown[]) => mockEnrichLibrary(...args),
  };
});

const baseResult: AuditResult = {
  name: "lodash",
  version: "4.17.21",
  score: 85,
  summary: "Looks good.",
  risks: [],
  investigationAreas: [],
  deepDiveFindings: [],
  dependencies: [],
  license: { type: "MIT", compatible: true, note: "" },
  maintainers: [],
  lastPublished: "recently",
  weeklyDownloads: "many",
  cves: [],
};

const baseInteraction = {
  provider: "openai" as const,
  model: "gpt-4o-mini",
  systemPrompt: "deep code review",
  userPrompt: "user",
  request: {},
  response: {},
  startedAt: "2024-01-01T00:00:00.000Z",
  finishedAt: "2024-01-01T00:00:02.000Z",
  tokensInput: 1000,
  tokensOutput: 500,
};

describe("runAudit", () => {
  beforeEach(() => {
    mockResolveLibrary.mockResolvedValue({
      source: "npm",
      url: "https://www.npmjs.com/package/lodash",
      name: "lodash",
      version: "4.17.21",
      metadata: {},
    });
    mockResolveCodebase.mockResolvedValue({
      files: [{ path: "package.json", size: 100, content: "{}" }],
      fileCount: 1,
      totalSize: 100,
    });
    mockEnrichLibrary.mockResolvedValue({ advisories: [] });
    mockComputeCacheKey.mockResolvedValue("cache-key-123");
    mockGetDb.mockResolvedValue({
      prepare: () => ({ bind: () => ({ first: mockDbFirst }) }),
    });
    mockDbFirst.mockResolvedValue(null);
    mockGetCachedAuditReport.mockResolvedValue(null);
    mockRunLibraryAudit.mockImplementation(
      async (
        _context: unknown,
        _prompt: unknown,
        onEvent?: (event: { type: "step" | "llm"; step?: string; status?: "started" | "completed"; phase?: string; tokensPerSecond?: number; tokensInput?: number; tokensOutput?: number; elapsedMs?: number }) => void | Promise<void>,
      ) => {
        await onEvent?.({ type: "step", step: "investigate", status: "started" });
        await onEvent?.({
          type: "llm",
          phase: "investigate",
          tokensPerSecond: 750,
          tokensInput: 1000,
          tokensOutput: 500,
          elapsedMs: 2000,
        });
        await onEvent?.({ type: "step", step: "investigate", status: "completed" });
        return { result: baseResult, interactions: [baseInteraction] };
      },
    );
    mockGetLlmConfig.mockReturnValue({ model: "gpt-4o-mini" });
    mockSaveAuditReport.mockResolvedValue({ auditId: 1, reportId: 2 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });


  it("emits step and llm events during a codebase audit", async () => {
    const events: AuditEvent[] = [];
    const { result, meta } = await runAudit(
      { libraryUrl: "https://www.npmjs.com/package/lodash" },
      (event) => {
        events.push(event);
      },
    );

    expect(result.name).toBe("lodash");
    expect(meta.cached).toBe(false);
    expect(meta.auditId).toBe(1);

    const steps = events
      .filter((e) => e.type === "step")
      .map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("resolve:started");
    expect(steps).toContain("resolve:completed");
    expect(steps).toContain("download:started");
    expect(steps).toContain("download:completed");
    expect(steps).toContain("validate:started");
    expect(steps).toContain("persist:completed");

    const llmEvents = events.filter((e) => e.type === "llm");
    expect(llmEvents.length).toBeGreaterThan(0);
    expect(llmEvents[0].tokensPerSecond).toBeGreaterThan(0);

    const etaEvents = events.filter((e) => e.type === "eta");
    expect(etaEvents.length).toBeGreaterThan(0);
  });

  it("runs two models and merges the results in competition mode", async () => {
    const modelAInteraction = {
      ...baseInteraction,
      model: "gpt-4o",
      systemPrompt: "deep code review",
    };
    const modelBInteraction = {
      ...baseInteraction,
      model: "claude-3-5-sonnet-20241022",
      systemPrompt: "deep code review",
    };
    mockRunLibraryAudit
      .mockResolvedValueOnce({
        result: { ...baseResult, score: 80 },
        interactions: [modelAInteraction],
      })
      .mockResolvedValueOnce({
        result: { ...baseResult, score: 90 },
        interactions: [modelBInteraction],
      });

    const events: AuditEvent[] = [];
    const { result, meta } = await runAudit(
      {
        libraryUrl: "https://www.npmjs.com/package/lodash",
        competitionMode: {
          enabled: true,
          modelA: { provider: "openai", model: "gpt-4o" },
          modelB: {
            provider: "anthropic",
            model: "claude-3-5-sonnet-20241022",
          },
          mergeModel: { provider: "openai", model: "gpt-4o-mini" },
        },
      },
      (event) => {
        events.push(event);
      },
    );

    expect(result.name).toBe("lodash");
    expect(meta.cached).toBe(false);
    expect(mockRunLibraryAudit).toHaveBeenCalledTimes(2);

    const steps = events
      .filter((e) => e.type === "step")
      .map((e) => `${e.step}:${e.status}`);
    expect(steps).toContain("investigate:started");
    expect(steps).toContain("investigate:completed");
    expect(steps).toContain("judge:started");
    expect(steps).toContain("judge:completed");
  });

  it("returns a cached result without running the LLM", async () => {
    mockGetCachedAuditReport.mockResolvedValue({
      id: 5,
      audit_id: 3,
      result_json: JSON.stringify(baseResult),
      interaction_json: JSON.stringify([baseInteraction]),
      codebase_inspected: 1,
      created_at: new Date().toISOString(),
    });

    const events: AuditEvent[] = [];
    const { meta } = await runAudit(
      { libraryUrl: "https://www.npmjs.com/package/lodash" },
      (event) => {
        events.push(event);
      },
    );

    expect(meta.cached).toBe(true);
    expect(meta.reportId).toBe(5);
    expect(mockRunLibraryAudit).not.toHaveBeenCalled();
    expect(
      events.some((e) => e.type === "step" && e.step === "persist"),
    ).toBe(false);
  });
});

describe("runAudit skipCache", () => {
  beforeEach(() => {
    mockResolveLibrary.mockResolvedValue({
      source: "npm",
      url: "https://www.npmjs.com/package/lodash",
      name: "lodash",
      version: "4.17.21",
      metadata: {},
    });
    mockResolveCodebase.mockResolvedValue({
      files: [{ path: "package.json", size: 100, content: "{}" }],
      fileCount: 1,
      totalSize: 100,
    });
    mockEnrichLibrary.mockResolvedValue({ advisories: [] });
    mockComputeCacheKey.mockResolvedValue("cache-key-123");
    mockGetDb.mockResolvedValue({
      prepare: () => ({ bind: () => ({ first: mockDbFirst }) }),
    });
    mockDbFirst.mockResolvedValue(null);
    mockGetCachedAuditReport.mockResolvedValue(null);
    mockRunLibraryAudit.mockResolvedValue({
      result: baseResult,
      interactions: [baseInteraction],
    });
    mockGetLlmConfig.mockReturnValue({ model: "gpt-4o-mini" });
    mockSaveAuditReport.mockResolvedValue({ auditId: 1, reportId: 2 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("bypasses the cache lookup when skipCache is true", async () => {
    mockGetCachedAuditReport.mockResolvedValue({
      id: 99,
      audit_id: 9,
      result_json: JSON.stringify(baseResult),
      interaction_json: JSON.stringify([baseInteraction]),
      codebase_inspected: 1,
      created_at: new Date().toISOString(),
    });

    const { meta } = await runAudit({
      libraryUrl: "https://www.npmjs.com/package/lodash",
      skipCache: true,
    });

    expect(mockGetCachedAuditReport).not.toHaveBeenCalled();
    expect(meta.cached).toBe(false);
  });

  it("persists with cache_key NULL when skipCache is true", async () => {
    await runAudit({
      libraryUrl: "https://www.npmjs.com/package/lodash",
      skipCache: true,
    });

    expect(mockSaveAuditReport).toHaveBeenCalledTimes(1);
    const saved = mockSaveAuditReport.mock.calls[0][1];
    expect(saved.cacheKey).toBeUndefined();
  });

  it("still uses the cache when skipCache is unset", async () => {
    mockGetCachedAuditReport.mockResolvedValue({
      id: 99,
      audit_id: 9,
      result_json: JSON.stringify(baseResult),
      interaction_json: JSON.stringify([baseInteraction]),
      codebase_inspected: 1,
      created_at: new Date().toISOString(),
    });

    const { meta } = await runAudit({
      libraryUrl: "https://www.npmjs.com/package/lodash",
    });

    expect(mockGetCachedAuditReport).toHaveBeenCalledTimes(1);
    expect(meta.cached).toBe(true);
    expect(meta.reportId).toBe(99);
    expect(mockSaveAuditReport).not.toHaveBeenCalled();
  });
});
