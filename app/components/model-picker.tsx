"use client";

import * as React from "react";
import type { ProviderConfig } from "@/app/lib/providers";

export interface ProviderModelSelection {
  providerId: string;
  model: string;
}

export function ModelPicker({
  label,
  configs,
  value,
  onChange,
  description,
}: {
  label: string;
  configs: ProviderConfig[];
  value: ProviderModelSelection;
  onChange: (value: ProviderModelSelection) => void;
  description?: string;
}) {
  const selectedConfig = configs.find((c) => c.id === value.providerId);
  const inputId = `${label.replace(/\s+/g, "-").toLowerCase()}-model`;

  return (
    <div className="space-y-1.5">
      <label
        htmlFor={inputId}
        className="text-xs font-medium text-muted-foreground"
      >
        {label}
      </label>
      <div className="grid grid-cols-[1fr_1fr] gap-2">
        <select
          value={value.providerId}
          onChange={(e) => {
            const config = configs.find((c) => c.id === e.target.value);
            onChange({
              providerId: e.target.value,
              model: config?.models[0] ?? "",
            });
          }}
          aria-label={`${label} provider`}
          className="h-10 w-full appearance-none rounded-lg border border-border bg-background px-2 pr-6 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {configs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          id={inputId}
          value={value.model}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
          disabled={!selectedConfig || selectedConfig.models.length === 0}
          aria-label={`${label} model`}
          className="h-10 w-full appearance-none rounded-lg border border-border bg-background px-2 pr-6 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {selectedConfig ? (
            selectedConfig.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          ) : (
            <option value="">No provider</option>
          )}
        </select>
      </div>
      {description && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
