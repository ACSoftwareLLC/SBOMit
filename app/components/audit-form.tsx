"use client";

import * as React from "react";
import {
  Link as LinkIcon,
  ChevronRight,
  ChevronDown,
  Loader2,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Search,
  Database,
  Ban,
  Tag,
  Bot,
  Cpu,
  Settings,
} from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import type { RunAuditInput } from "@/app/lib/run-audit";
import {
  ModelPicker,
  type ProviderModelSelection,
} from "@/app/components/model-picker";
import { displayUrlLabel } from "@/app/components/audit-jobs";
import { providerLabels, type ProviderConfig } from "@/app/lib/providers";

interface Suggestion {
  name: string;
  description: string;
}

const exampleUrls = [
  "https://www.npmjs.com/package/lodash",
  "https://www.npmjs.com/package/express",
  "https://www.npmjs.com/package/axios",
  "https://github.com/facebook/react",
];

function looksLikePackageName(value: string): boolean {
  return /^[^/\s:]+$/.test(value.trim());
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (looksLikePackageName(trimmed)) {
    return `https://www.npmjs.com/package/${trimmed}`;
  }
  return trimmed;
}

function isNpmPackageInput(value: string): boolean {
  const trimmed = value.trim();
  if (looksLikePackageName(trimmed)) return true;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.hostname.endsWith("npmjs.com") &&
      parsed.pathname.startsWith("/package/")
    );
  } catch {
    return false;
  }
}

export function AuditForm({
  configs,
  selectedConfig,
  selectedId,
  setSelectedId,
  setModel,
  effectiveModel,
  loading,
  error,
  cancelled,
  onSubmit,
}: {
  configs: ProviderConfig[];
  selectedConfig: ProviderConfig | null;
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  setModel: (model: string) => void;
  effectiveModel: string;
  loading: boolean;
  error: string | null;
  cancelled: boolean;
  onSubmit: (input: RunAuditInput) => void;
}) {
  const [libraryUrl, setLibraryUrl] = React.useState("");
  const [version, setVersion] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [savingDeps, setSavingDeps] = React.useState(false);
  const [depsError, setDepsError] = React.useState<string | null>(null);
  const [savedDeps, setSavedDeps] = React.useState<{
    auditId: number;
    count: number;
  } | null>(null);
  const [suggestions, setSuggestions] = React.useState<Suggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1);
  const suggestionsRef = React.useRef<HTMLDivElement>(null);
  const [versions, setVersions] = React.useState<string[]>([]);
  const [versionsLoading, setVersionsLoading] = React.useState(false);
  const [versionsLatest, setVersionsLatest] = React.useState<string | null>(
    null,
  );
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [competitionMode, setCompetitionMode] = React.useState(false);
  const [competitionModelA, setCompetitionModelA] =
    React.useState<ProviderModelSelection>({
      providerId: "",
      model: "",
    });
  const [competitionModelB, setCompetitionModelB] =
    React.useState<ProviderModelSelection>({
      providerId: "",
      model: "",
    });
  const [competitionMergeModel, setCompetitionMergeModel] =
    React.useState<ProviderModelSelection>({
      providerId: "",
      model: "",
    });

  React.useEffect(() => {
    const trimmed = libraryUrl.trim();
    const timer = setTimeout(async () => {
      if (!trimmed || !looksLikePackageName(trimmed)) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { packages: Suggestion[] };
        setSuggestions(data.packages || []);
        setShowSuggestions(true);
        setHighlightedIndex(-1);
      } catch {
        // Ignore autocomplete errors
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [libraryUrl]);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  React.useEffect(() => {
    const trimmed = libraryUrl.trim();
    const timer = setTimeout(async () => {
      if (!trimmed || !isNpmPackageInput(trimmed)) {
        setVersions([]);
        setVersionsLatest(null);
        return;
      }
      setVersionsLoading(true);
      try {
        const res = await fetch(
          `/api/versions?q=${encodeURIComponent(trimmed)}`,
        );
        if (!res.ok) {
          setVersions([]);
          setVersionsLatest(null);
          return;
        }
        const data = (await res.json()) as {
          versions: string[];
          latest: string | null;
        };
        setVersions(data.versions || []);
        setVersionsLatest(data.latest || null);
      } catch {
        setVersions([]);
        setVersionsLatest(null);
      } finally {
        setVersionsLoading(false);
      }
    }, 200);

    return () => clearTimeout(timer);
  }, [libraryUrl]);

  const selectSuggestion = React.useCallback((name: string) => {
    setLibraryUrl(`https://www.npmjs.com/package/${name}`);
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightedIndex(-1);
  }, []);

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (!showSuggestions || suggestions.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0,
        );
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1,
        );
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        selectSuggestion(suggestions[highlightedIndex].name);
      } else if (e.key === "Escape") {
        setShowSuggestions(false);
      }
    },
    [showSuggestions, suggestions, highlightedIndex, selectSuggestion],
  );

  const handleAudit = React.useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!libraryUrl.trim()) return;
      setDepsError(null);
      setSavedDeps(null);

      const normalizedUrl = normalizeUrl(libraryUrl);
      const normalizedVersion = version.trim() || undefined;

      const input: RunAuditInput = {
        libraryUrl: normalizedUrl,
        version: normalizedVersion,
        prompt: prompt.trim() || undefined,
      };
      if (competitionMode) {
        input.competitionMode = {
          enabled: true,
          modelA: competitionModelA,
          modelB: competitionModelB,
          mergeModel: competitionMergeModel,
        };
      } else if (selectedConfig) {
        input.providerId = selectedConfig.id;
        input.model = effectiveModel;
      }

      onSubmit(input);
    },
    [
      libraryUrl,
      version,
      prompt,
      effectiveModel,
      selectedConfig,
      competitionMode,
      competitionModelA,
      competitionModelB,
      competitionMergeModel,
      onSubmit,
    ],
  );

  const handleSaveDependencies = React.useCallback(async () => {
    if (!libraryUrl.trim()) return;
    setSavingDeps(true);
    setDepsError(null);
    setSavedDeps(null);

    const normalizedUrl = normalizeUrl(libraryUrl);

    try {
      const res = await fetch("/api/dependencies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryUrl: normalizedUrl }),
      });

      const data = (await res.json()) as {
        auditId?: number;
        dependencies?: Array<Record<string, string>>;
        error?: string;
      };

      if (!res.ok || data.error) {
        throw new Error(data.error || "Failed to save dependencies.");
      }

      setSavedDeps({
        auditId: data.auditId ?? 0,
        count: data.dependencies?.length ?? 0,
      });
    } catch (err) {
      setDepsError(
        err instanceof Error ? err.message : "Something went wrong.",
      );
    } finally {
      setSavingDeps(false);
    }
  }, [libraryUrl]);

  return (
    <>
      <form
        onSubmit={handleAudit}
        className="mx-auto mt-10 max-w-2xl rounded-2xl border border-border bg-card p-2 shadow-lg sm:p-3"
      >
        <div className="flex flex-col gap-3">
          <div className="relative" ref={suggestionsRef}>
            <LinkIcon className="absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={libraryUrl}
              onChange={(e) => setLibraryUrl(e.target.value)}
              onFocus={() => {
                if (suggestions.length > 0) setShowSuggestions(true);
              }}
              onKeyDown={handleKeyDown}
              placeholder="npm package or GitHub URL, e.g. lodash"
              className="h-14 border-0 bg-transparent pl-11 text-base shadow-none focus-visible:ring-0"
              autoComplete="off"
              aria-autocomplete="list"
              aria-controls="library-url-suggestions"
              aria-expanded={showSuggestions}
            />
            {showSuggestions && suggestions.length > 0 && (
              <div
                id="library-url-suggestions"
                className="absolute z-50 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-border bg-card p-1 shadow-xl"
                role="listbox"
              >
                {suggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.name}
                    type="button"
                    role="option"
                    aria-selected={index === highlightedIndex}
                    onClick={() => selectSuggestion(suggestion.name)}
                    className={cn(
                      "w-full rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent",
                      index === highlightedIndex && "bg-accent",
                    )}
                  >
                    <div className="flex items-center gap-2 font-medium">
                      <Search className="h-4 w-4 text-muted-foreground" />
                      {suggestion.name}
                    </div>
                    {suggestion.description && (
                      <div className="line-clamp-1 text-xs text-muted-foreground">
                        {suggestion.description}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <Tag className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <select
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              disabled={versionsLoading || versions.length === 0}
              aria-label="Version"
              className="h-12 w-full appearance-none rounded-lg border-0 bg-muted/50 pl-11 pr-10 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="">
                {versionsLoading
                  ? "Loading versions..."
                  : versions.length === 0
                    ? "Version (optional)"
                    : versionsLatest
                      ? `Latest (${versionsLatest})`
                      : "Latest"}
              </option>
              {versions.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <ChevronRight className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-muted-foreground" />
          </div>

          <div className="relative">
            <Bot className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <select
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value || null)}
              disabled={configs.length === 0}
              aria-label="AI provider"
              className="h-12 w-full appearance-none rounded-lg border-0 bg-muted/50 pl-11 pr-10 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              {configs.length === 0 ? (
                <option value="">No providers configured</option>
              ) : (
                configs.map((config) => (
                  <option key={config.id} value={config.id}>
                    {config.name} ({providerLabels[config.provider]})
                  </option>
                ))
              )}
            </select>
            <ChevronRight className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-muted-foreground" />
          </div>

          <div className="relative">
            <Cpu className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
            <select
              value={effectiveModel}
              onChange={(e) => setModel(e.target.value)}
              disabled={!selectedConfig || selectedConfig.models.length === 0}
              aria-label="Model"
              className="h-12 w-full appearance-none rounded-lg border-0 bg-muted/50 pl-11 pr-10 text-base text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              {!selectedConfig ? (
                <option value="">Select a provider first</option>
              ) : selectedConfig.models.length === 0 ? (
                <option value="">No models configured</option>
              ) : (
                selectedConfig.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              )}
            </select>
            <ChevronRight className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-muted-foreground" />
          </div>

          {configs.length === 0 && (
            <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
              Add an LLM provider in{" "}
              <a
                href="/settings"
                className="font-medium text-primary hover:underline"
              >
                Settings
              </a>{" "}
              to run audits.
            </div>
          )}

          <div className="relative">
            <MessageSquare className="absolute left-3.5 top-3 h-5 w-5 text-muted-foreground" />
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Optional prompt, e.g. Focus on supply-chain risks for a fintech product."
              rows={2}
              className="w-full resize-none rounded-lg border-0 bg-muted/50 px-10 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setAdvancedOpen((prev) => !prev)}
              className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium hover:bg-muted/50"
              aria-expanded={advancedOpen}
            >
              <span className="flex items-center gap-2">
                <Settings className="h-4 w-4 text-muted-foreground" />
                Advanced
              </span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
            </button>
            {advancedOpen && (
              <div className="space-y-4 border-t border-border bg-muted/30 px-4 py-4">
                <button
                  type="button"
                  onClick={() => {
                    setCompetitionMode((prev) => {
                      const next = !prev;
                      if (next && selectedConfig) {
                        const defaultSelection = {
                          providerId: selectedConfig.id,
                          model: selectedConfig.models[0] ?? "",
                        };
                        setCompetitionModelA((current) =>
                          current.providerId ? current : defaultSelection,
                        );
                        setCompetitionModelB((current) =>
                          current.providerId ? current : defaultSelection,
                        );
                        setCompetitionMergeModel((current) =>
                          current.providerId ? current : defaultSelection,
                        );
                      }
                      return next;
                    });
                  }}
                  className="flex w-full items-center justify-between"
                  aria-pressed={competitionMode}
                >
                  <span className="text-sm font-medium">Competition mode</span>
                  <span
                    className={cn(
                      "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                      competitionMode ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-block h-4 w-4 transform rounded-full bg-background transition-transform",
                        competitionMode ? "translate-x-6" : "translate-x-1",
                      )}
                    />
                  </span>
                </button>
                <p className="text-xs text-muted-foreground">
                  Run two models against the same audit in parallel, then use a
                  third model to remove duplicates and combine the results into
                  one report.
                </p>

                {competitionMode && (
                  <div className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ModelPicker
                        label="Model A"
                        configs={configs}
                        value={competitionModelA}
                        onChange={setCompetitionModelA}
                      />
                      <ModelPicker
                        label="Model B"
                        configs={configs}
                        value={competitionModelB}
                        onChange={setCompetitionModelB}
                      />
                    </div>
                    <ModelPicker
                      label="Merge model"
                      configs={configs}
                      value={competitionMergeModel}
                      onChange={setCompetitionMergeModel}
                      description="This model removes duplicate findings and combines both reports into one."
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <Button
            type="submit"
            disabled={
              loading ||
              !libraryUrl.trim() ||
              (competitionMode
                ? !competitionModelA.providerId ||
                  !competitionModelA.model ||
                  !competitionModelB.providerId ||
                  !competitionModelB.model ||
                  !competitionMergeModel.providerId ||
                  !competitionMergeModel.model
                : !selectedConfig || !effectiveModel)
            }
            className="h-12 px-8 text-base"
          >
            {loading ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Auditing with AI
              </>
            ) : (
              <>
                Audit Library
                <ChevronRight className="ml-2 h-5 w-5" />
              </>
            )}
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={savingDeps || !libraryUrl.trim()}
            onClick={handleSaveDependencies}
            className="h-12 px-8 text-base"
          >
            {savingDeps ? (
              <>
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Saving Tree
              </>
            ) : (
              <>
                <Database className="mr-2 h-5 w-5" />
                Save Dependency Tree
              </>
            )}
          </Button>
        </div>
      </form>

      {depsError && (
        <div className="mx-auto mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{depsError}</p>
        </div>
      )}

      {savedDeps && (
        <div className="mx-auto mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            Saved {savedDeps.count} direct dependencies to D1 (audit #
            {savedDeps.auditId}).
          </p>
        </div>
      )}

      {error && (
        <div className="mx-auto mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-left text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {cancelled && (
        <div className="mx-auto mt-4 flex max-w-2xl items-start gap-3 rounded-xl border border-border bg-muted/50 px-4 py-3 text-left text-muted-foreground">
          <Ban className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            Audit cancelled. No report was generated — start a new audit
            whenever you&apos;re ready.
          </p>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
        <span>Try:</span>
        {exampleUrls.map((url) => (
          <button
            key={url}
            type="button"
            onClick={() => setLibraryUrl(url)}
            className="rounded-full border border-border bg-card px-3 py-1 hover:bg-accent hover:text-accent-foreground"
          >
            {displayUrlLabel(url)}
          </button>
        ))}
      </div>
    </>
  );
}
