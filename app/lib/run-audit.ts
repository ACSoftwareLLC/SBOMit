import {
  computeCacheKey,
  postProcessAuditResult,
  resolveCodebase,
  resolveLibrary,
  type AuditResult,
  type CompetitionReadout,
  type LibraryContext,
} from "./audit";
import {
  getDb,
  getProviderById,
  saveAuditReport,
  type StoredAuditReport,
} from "./db";
import {
  getLlmConfig,
  mergeAuditResults,
  runLibraryAudit,
  type LlmConfig,
  type LlmConfigOverride,
  type LlmInteraction,
} from "./llm";
import { MissingInputError } from "./errors";
import { enrichLibrary } from "./signals";
import { getCachedAuditReport } from "./cache";
import { isProvider, type Provider } from "./providers";

export type AuditStep =
  | "resolve"
  | "download"
  | "investigate"
  | "deep-dive"
  | "metadata-only"
  | "judge"
  | "validate"
  | "persist";

export type CompetitionModelStep =
  | "investigate"
  | "deep-dive"
  | "metadata-only";

export type AuditEvent =
  | {
      type: "step";
      step: AuditStep;
      status: "started" | "completed";
      detail?: string;
    }
  | {
      type: "competition";
      model: "A" | "B";
      step: CompetitionModelStep;
      status: "started" | "completed";
      detail?: string;
    }
  | {
      type: "llm";
      phase: string;
      tokensPerSecond: number;
      tokensInput?: number;
      tokensOutput?: number;
      elapsedMs: number;
    }
  | {
      type: "eta";
      estimatedFinishAt: number;
    };

export type AuditEventHandler = (event: AuditEvent) => void | Promise<void>;

export interface LlmSelection {
  providerId?: string;
  provider?: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface CompetitionModeConfig {
  enabled: true;
  modelA: LlmSelection;
  modelB: LlmSelection;
  mergeModel: LlmSelection;
}

export interface RunAuditInput {
  libraryUrl: string;
  version?: string;
  prompt?: string;
  providerId?: string;
  provider?: Provider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  competitionMode?: CompetitionModeConfig;
  userId?: number;
  /** Re-audit mode: skip cache reads and persist without a cache key. */
  skipCache?: boolean;
}

export interface RunAuditResult {
  result: AuditResult;
  meta: {
    cached: boolean;
    auditId: number;
    reportId: number;
    codebaseInspected: boolean;
    interactions: LlmInteraction[];
    competitionReadout?: CompetitionReadout | null;
  };
}

function parseLlmSelection(
  value: unknown,
  label: string,
): LlmSelection | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const {
    providerId,
    provider,
    model,
    apiKey,
    baseUrl,
  } = value as {
    providerId?: unknown;
    provider?: unknown;
    model?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
  };
  const selection: LlmSelection = {};
  if (typeof providerId === "string" && providerId.trim()) {
    selection.providerId = providerId.trim();
  }
  if (typeof provider === "string" && provider.trim()) {
    const trimmed = provider.trim() as Provider;
    if (!isProvider(trimmed)) {
      throw new MissingInputError(
        `${label} provider must be openai, anthropic, or google.`,
      );
    }
    selection.provider = trimmed;
  }
  if (typeof model === "string" && model.trim()) {
    selection.model = model.trim();
  }
  if (typeof apiKey === "string" && apiKey.trim()) {
    selection.apiKey = apiKey.trim();
  }
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    selection.baseUrl = baseUrl.trim();
  }
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function parseCompetitionMode(
  body: Record<string, unknown>,
): CompetitionModeConfig | undefined {
  const competitionMode = body.competitionMode;
  if (!competitionMode || typeof competitionMode !== "object") {
    return undefined;
  }
  const { enabled, modelA, modelB, mergeModel } = competitionMode as {
    enabled?: unknown;
    modelA?: unknown;
    modelB?: unknown;
    mergeModel?: unknown;
  };
  if (!enabled) return undefined;

  const parsedA = parseLlmSelection(modelA, "modelA");
  const parsedB = parseLlmSelection(modelB, "modelB");
  const parsedMerge = parseLlmSelection(mergeModel, "mergeModel");

  if (!parsedA || (!parsedA.providerId && !parsedA.provider)) {
    throw new MissingInputError(
      "Competition mode modelA requires providerId or provider.",
    );
  }
  if (!parsedB || (!parsedB.providerId && !parsedB.provider)) {
    throw new MissingInputError(
      "Competition mode modelB requires providerId or provider.",
    );
  }
  if (!parsedMerge || (!parsedMerge.providerId && !parsedMerge.provider)) {
    throw new MissingInputError(
      "Competition mode mergeModel requires providerId or provider.",
    );
  }

  return {
    enabled: true,
    modelA: parsedA,
    modelB: parsedB,
    mergeModel: parsedMerge,
  };
}

export function parseRequestBody(body: unknown): RunAuditInput {
  if (!body || typeof body !== "object") {
    throw new MissingInputError();
  }
  const {
    libraryUrl,
    version,
    prompt,
    providerId,
    provider,
    model,
    apiKey,
    baseUrl,
  } = body as {
    libraryUrl?: unknown;
    version?: unknown;
    prompt?: unknown;
    providerId?: unknown;
    provider?: unknown;
    model?: unknown;
    apiKey?: unknown;
    baseUrl?: unknown;
  };
  if (typeof libraryUrl !== "string" || libraryUrl.trim().length === 0) {
    throw new MissingInputError();
  }

  const trimmedProvider: Provider | undefined =
    typeof provider === "string" ? (provider.trim() as Provider) : undefined;
  if (trimmedProvider && !isProvider(trimmedProvider)) {
    throw new MissingInputError(`Unsupported LLM provider: ${trimmedProvider}`);
  }

  const result: RunAuditInput = {
    libraryUrl: libraryUrl.trim(),
    version:
      typeof version === "string" && version.trim().length > 0
        ? version.trim()
        : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
    competitionMode: parseCompetitionMode(body as Record<string, unknown>),
  };

  if (typeof providerId === "string" && providerId.trim()) {
    result.providerId = providerId.trim();
  }
  if (trimmedProvider) result.provider = trimmedProvider;
  if (typeof model === "string" && model.trim().length > 0) {
    result.model = model.trim();
  }
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    result.apiKey = apiKey.trim();
  }
  if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
    result.baseUrl = baseUrl.trim();
  }

  return result;
}

function storedReportToResult(report: StoredAuditReport): AuditResult {
  const parsed = JSON.parse(report.result_json) as Partial<AuditResult>;
  return {
    name: parsed.name ?? "",
    version: parsed.version ?? "",
    score: parsed.score ?? 0,
    summary: parsed.summary ?? "",
    risks: parsed.risks ?? [],
    investigationAreas: parsed.investigationAreas ?? [],
    deepDiveFindings: parsed.deepDiveFindings ?? [],
    dependencies: parsed.dependencies ?? [],
    license: parsed.license ?? { type: "", compatible: true, note: "" },
    maintainers: parsed.maintainers ?? [],
    lastPublished: parsed.lastPublished ?? "",
    weeklyDownloads: parsed.weeklyDownloads ?? "",
    cves: parsed.cves ?? [],
    competitionReadout: parsed.competitionReadout,
  };
}

function storedReportToInteractions(
  report: StoredAuditReport,
): LlmInteraction[] | undefined {
  if (!report.interaction_json) return undefined;
  const parsed = JSON.parse(report.interaction_json) as
    | LlmInteraction
    | LlmInteraction[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

const STEP_ORDER: AuditStep[] = [
  "resolve",
  "download",
  "investigate",
  "deep-dive",
  "validate",
  "persist",
];

function estimateFinishAt(
  startedAt: number,
  completedStep: AuditStep,
): number {
  const elapsedMs = Date.now() - startedAt;
  const completedIndex = STEP_ORDER.indexOf(completedStep);
  if (completedIndex <= 0) {
    return Date.now() + Math.max(5000, elapsedMs * 2);
  }
  const avgMsPerStep = elapsedMs / (completedIndex + 1);
  const remainingSteps = STEP_ORDER.length - (completedIndex + 1);
  return Date.now() + avgMsPerStep * Math.max(1, remainingSteps);
}

async function emitStep(
  onEvent: AuditEventHandler | undefined,
  step: AuditStep,
  status: "started" | "completed",
  detail?: string,
): Promise<void> {
  if (!onEvent) return;
  await onEvent({ type: "step", step, status, detail });
}

async function emitEta(
  onEvent: AuditEventHandler | undefined,
  startedAt: number,
  completedStep: AuditStep,
): Promise<void> {
  if (!onEvent) return;
  await onEvent({
    type: "eta",
    estimatedFinishAt: estimateFinishAt(startedAt, completedStep),
  });
}

async function resolveLlmConfig(
  selection: LlmSelection,
  db: D1Database,
): Promise<LlmConfig> {
  if (selection.providerId) {
    const providerRow = await getProviderById(db, selection.providerId);
    if (!providerRow) {
      throw new MissingInputError(`Provider not found: ${selection.providerId}`);
    }
    const dbModels = JSON.parse(providerRow.models) as string[];
    const override: LlmConfigOverride = {
      provider: providerRow.provider,
      apiKey: providerRow.api_key,
      model: selection.model ?? dbModels[0] ?? undefined,
      baseUrl: providerRow.base_url ?? undefined,
      providerId: selection.providerId,
    };
    return getLlmConfig(override);
  }
  return getLlmConfig({
    provider: selection.provider,
    model: selection.model,
    apiKey: selection.apiKey,
    baseUrl: selection.baseUrl,
  });
}

function selectionLabel(selection: LlmSelection): string {
  if (selection.providerId) {
    return `${selection.providerId}/${selection.model ?? "default"}`;
  }
  return `${selection.provider}/${selection.model ?? "default"}`;
}

export async function runAudit(
  input: RunAuditInput,
  onEvent?: AuditEventHandler,
  db?: D1Database,
): Promise<RunAuditResult> {
  const { libraryUrl, version, prompt, competitionMode } = input;
  const startedAt = Date.now();
  const isCompetitionMode = competitionMode?.enabled === true;

  const dbInstance = db ?? (await getDb());

  await emitStep(onEvent, "resolve", "started");
  const context = await resolveLibrary(libraryUrl, version);
  await emitStep(onEvent, "resolve", "completed", context.name);

  await emitStep(onEvent, "download", "started");
  const codebase = await resolveCodebase(context);
  const codebaseInspected = !!codebase && codebase.files.length > 0;
  const baseContext: LibraryContext = {
    ...context,
    ...(codebase ? { codebase } : {}),
  };

  // Enrichment runs in parallel with codebase download and is failure-tolerant.
  const signals = await enrichLibrary(baseContext);
  const fullContext: LibraryContext = {
    ...baseContext,
    signals,
  };

  const advisoryCount = signals.advisories.length;
  await emitStep(
    onEvent,
    "download",
    "completed",
    codebase
      ? `${codebase.fileCount} files, ${codebase.totalSize} bytes${advisoryCount > 0 ? `, ${advisoryCount} advisories` : ""}`
      : advisoryCount > 0
        ? `metadata only, ${advisoryCount} advisories`
        : "metadata only",
  );

  const defaultSelection: LlmSelection = {
    providerId: input.providerId,
    provider: input.provider,
    model: input.model,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
  };

  let primaryConfig: LlmConfig;
  if (isCompetitionMode) {
    primaryConfig = await resolveLlmConfig(competitionMode.modelA, dbInstance);
  } else if (
    defaultSelection.providerId ||
    defaultSelection.provider ||
    defaultSelection.model
  ) {
    primaryConfig = await resolveLlmConfig(defaultSelection, dbInstance);
  } else {
    primaryConfig = getLlmConfig();
  }

  const cacheKey = await computeCacheKey(
    fullContext,
    prompt,
    primaryConfig.provider,
    primaryConfig.model,
  );

  const cached = input.skipCache
    ? null
    : await getCachedAuditReport(
        dbInstance,
        cacheKey,
        fullContext.version,
      );

  if (cached) {
    const result = storedReportToResult(cached);
    const interactions = storedReportToInteractions(cached) ?? [];
    return {
      result,
      meta: {
        cached: true,
        auditId: cached.audit_id,
        reportId: cached.id,
        codebaseInspected: cached.codebase_inspected === 1,
        interactions,
        competitionReadout: result.competitionReadout,
      },
    };
  }

  let result: AuditResult;
  let interactions: LlmInteraction[];
  let model: string;

  if (isCompetitionMode) {
    const [configA, configB, mergeConfig] = await Promise.all([
      resolveLlmConfig(competitionMode.modelA, dbInstance),
      resolveLlmConfig(competitionMode.modelB, dbInstance),
      resolveLlmConfig(competitionMode.mergeModel, dbInstance),
    ]);

    await emitStep(onEvent, "investigate", "started");
    const [{ result: resultA, interactions: interactionsA }, { result: resultB, interactions: interactionsB }] =
      await Promise.all([
        runLibraryAudit(
          fullContext,
          prompt,
          async (event) => {
            // Forward per-model step progress plus LLM and ETA events.
            if (event.type === "step") {
              const step: CompetitionModelStep | undefined =
                event.step === "investigate" || event.step === "deep-dive" || event.step === "metadata-only"
                  ? event.step
                  : undefined;
              if (step) {
                await onEvent?.({
                  type: "competition",
                  model: "A",
                  step,
                  status: event.status,
                  detail: event.detail,
                });
              }
            }
            if (event.type === "llm" || event.type === "eta") {
              await onEvent?.(event);
            }
          },
          configA,
        ),
        runLibraryAudit(
          fullContext,
          prompt,
          async (event) => {
            if (event.type === "step") {
              const step: CompetitionModelStep | undefined =
                event.step === "investigate" || event.step === "deep-dive" || event.step === "metadata-only"
                  ? event.step
                  : undefined;
              if (step) {
                await onEvent?.({
                  type: "competition",
                  model: "B",
                  step,
                  status: event.status,
                  detail: event.detail,
                });
              }
            }
            if (event.type === "llm" || event.type === "eta") {
              await onEvent?.(event);
            }
          },
          configB,
        ),
      ]);
    await emitStep(onEvent, "investigate", "completed");
    await emitEta(onEvent, startedAt, "investigate");

    await emitStep(onEvent, "judge", "started");
    const { result: mergedResult, exclusions, interaction: mergeInteraction } =
      await mergeAuditResults(
        resultA,
        resultB,
        mergeConfig,
        prompt,
      );
    const competitionReadout: CompetitionReadout = {
      modelA: {
        provider: configA.provider,
        model: configA.model,
        result: resultA,
      },
      modelB: {
        provider: configB.provider,
        model: configB.model,
        result: resultB,
      },
      judge: {
        provider: mergeConfig.provider,
        model: mergeConfig.model,
      },
      exclusions,
    };
    mergedResult.competitionReadout = competitionReadout;
    result = postProcessAuditResult(mergedResult, fullContext);
    interactions = [...interactionsA, ...interactionsB, mergeInteraction];
    model = `competition: ${selectionLabel(competitionMode.modelA)} + ${selectionLabel(competitionMode.modelB)} → ${selectionLabel(competitionMode.mergeModel)}`;
    await emitStep(onEvent, "judge", "completed");
    await emitEta(onEvent, startedAt, "judge");
  } else {
    const audit = await runLibraryAudit(
      fullContext,
      prompt,
      async (event) => {
        await onEvent?.(event);
        if (event.type === "step" && event.status === "completed") {
          await emitEta(onEvent, startedAt, event.step);
        }
      },
      primaryConfig,
    );
    result = postProcessAuditResult(audit.result, fullContext);
    interactions = audit.interactions;
    model = `${primaryConfig.provider}/${primaryConfig.model}`;
  }

  await emitStep(onEvent, "validate", "started");
  const resultJson = JSON.stringify(result);
  const interactionJson = JSON.stringify(interactions);
  const providerModels = Array.from(
    new Map(
      interactions
        .filter((i) => i.providerId)
        .map((i) => [i.providerId, { providerId: i.providerId, model: i.model }]),
    ).values(),
  );
  await emitStep(onEvent, "validate", "completed");

  await emitStep(onEvent, "persist", "started");
  const { auditId, reportId } = await saveAuditReport(dbInstance, {
    name: result.name,
    version: result.version,
    source: fullContext.source,
    url: fullContext.url,
    prompt,
    model,
    score: result.score,
    resultJson,
    cacheKey: input.skipCache ? undefined : cacheKey,
    interactionJson,
    codebaseInspected,
    userId: input.userId,
    providerModels,
    cached: false,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
  });
  await emitStep(onEvent, "persist", "completed");

  return {
    result,
    meta: {
      cached: false,
      auditId,
      reportId,
      codebaseInspected,
      interactions,
      competitionReadout: result.competitionReadout,
    },
  };
}
