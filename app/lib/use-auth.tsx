"use client";

import * as React from "react";
import { apiFetch, apiFetchJson } from "@/app/lib/api-fetch";

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  fullName: string;
  isAdmin: boolean;
}

export interface UseAuthResult {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  register: (input: {
    username: string;
    email: string;
    fullName: string;
    password: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = React.createContext<UseAuthResult | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiFetch<{ user: AuthUser | null }>("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      setUser(data.user ?? null);
    } catch (err) {
      const status = typeof err === "object" && err !== null ? (err as { status?: number }).status : undefined;
      if (status === 401) {
        setUser(null);
        return;
      }
      setError(err instanceof Error ? err.message : "Failed to load session.");
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    // Single shared session load on app mount. Fetching from the server is
    // an intentional side effect here because the provider owns the session
    // state for the whole tree.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const login = React.useCallback(async (username: string, password: string) => {
    const data = await apiFetchJson<{ user?: AuthUser }>(
      "/api/auth/login",
      { username, password },
      { credentials: "same-origin" },
    );
    setUser(data.user ?? null);
  }, []);

  const register = React.useCallback(
    async (input: {
      username: string;
      email: string;
      fullName: string;
      password: string;
    }) => {
      const data = await apiFetchJson<{ user?: AuthUser }>(
        "/api/auth/register",
        input,
        { credentials: "same-origin" },
      );
      setUser(data.user ?? null);
    },
    [],
  );

  const logout = React.useCallback(async () => {
    await apiFetch<Record<string, unknown>>("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    setUser(null);
  }, []);

  const value = React.useMemo(
    () => ({ user, loading, error, refresh, login, register, logout }),
    [user, loading, error, refresh, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): UseAuthResult {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
