"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Settings, Shield, User, LogOut, Users, BarChart3, ShieldAlert } from "lucide-react";
import { useAuditJobs } from "./audit-jobs";
import { NotificationBell } from "./notification-bell";
import { useAuth } from "@/app/lib/use-auth";
import { cn } from "@/app/lib/utils";

export function SiteHeader() {
  const { jobs } = useAuditJobs();
  const { user, loading, logout } = useAuth();
  const runningCount = jobs.filter((job) => job.status === "running").length;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:px-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
            <Shield className="h-5 w-5" />
          </div>
          <span className="text-lg font-bold tracking-tight">sbomit</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm font-medium text-muted-foreground">
          <Link
            href="/audits"
            className="flex items-center gap-1.5 hover:text-foreground"
          >
            Audits
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
                <Loader2 className="h-3 w-3 animate-spin" />
                {runningCount} running
              </span>
            )}
          </Link>
          {user?.isAdmin && (
            <Link
              href="/admin/users"
              className="hidden items-center gap-1.5 hover:text-foreground sm:flex"
            >
              <Users className="h-4 w-4" />
              Users
            </Link>
          )}
          {user?.isAdmin && (
            <Link
              href="/admin/settings"
              className="hidden items-center gap-1.5 hover:text-foreground sm:flex"
            >
              <ShieldAlert className="h-4 w-4" />
              Admin
            </Link>
          )}
          {user?.isAdmin && (
            <Link
              href="/admin/stats"
              className="hidden items-center gap-1.5 hover:text-foreground sm:flex"
            >
              <BarChart3 className="h-4 w-4" />
              Stats
            </Link>
          )}
          <Link
            href="/settings"
            className="flex items-center gap-1.5 hover:text-foreground"
          >
            <Settings className="h-4 w-4" />
            Settings
          </Link>

          {user && <NotificationBell />}

          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : user ? (
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setMenuOpen((prev) => !prev)}
                className="flex items-center gap-1.5 hover:text-foreground"
              >
                <User className="h-4 w-4" />
                <span className="hidden sm:inline">{user.username}</span>
              </button>
              {menuOpen && (
                <div className="absolute right-0 mt-2 w-48 rounded-lg border border-border bg-card p-1 shadow-lg">
                  <Link
                    href="/profile"
                    className="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-accent"
                    onClick={() => setMenuOpen(false)}
                  >
                    <User className="h-4 w-4" />
                    Profile
                  </Link>
                  <Link
                    href="/stats"
                    className="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-accent"
                    onClick={() => setMenuOpen(false)}
                  >
                    <BarChart3 className="h-4 w-4" />
                    Stats
                  </Link>
                  <button
                    type="button"
                    onClick={async () => {
                      setMenuOpen(false);
                      await logout();
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-accent"
                  >
                    <LogOut className="h-4 w-4" />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          ) : (
            <Link
              href="/login"
              className={cn(
                "rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90",
              )}
            >
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
