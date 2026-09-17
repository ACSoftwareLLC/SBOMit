"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { cn } from "@/app/lib/utils";

interface NotificationItem {
  id: number;
  type: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
  reportPublicId: string | null;
  previousReportPublicId: string | null;
}

interface NotificationListResponse {
  items: NotificationItem[];
  unreadCount: number;
  nextOffset: number | null;
}

const POLL_INTERVAL_MS = 60_000;

/** Relative time like "5m ago" / "2h ago" / "3d ago". */
function formatRelativeTime(iso: string): string {
  const date = new Date(`${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const [unreadCount, setUnreadCount] = React.useState<number | null>(null);
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<NotificationItem[] | null>(null);
  const [loadingList, setLoadingList] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  const fetchUnreadCount = React.useCallback(async () => {
    try {
      const res = await fetch("/api/notifications?unread=1&limit=1", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<NotificationListResponse>;
      if (typeof data.unreadCount === "number") {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // Badge refresh is best-effort.
    }
  }, []);

  const fetchList = React.useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/notifications?limit=10", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as Partial<NotificationListResponse>;
      setItems(data.items ?? []);
      if (typeof data.unreadCount === "number") {
        setUnreadCount(data.unreadCount);
      }
    } catch {
      // Keep whatever was rendered.
    } finally {
      setLoadingList(false);
    }
  }, []);

  // Badge polling: on mount, on becoming visible, and every 60s while
  // visible. The interval is cleared while the document is hidden.
  React.useEffect(() => {
    // Initial badge fetch on mount. Deferred a tick so the effect body
    // only wires external subscriptions (timer + visibility listener) —
    // same pattern as the audits page's mount fetch.
    const initial = window.setTimeout(() => void fetchUnreadCount(), 0);

    let pollTimer = 0;
    function startPollTimer() {
      window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => {
        if (!document.hidden) void fetchUnreadCount();
      }, POLL_INTERVAL_MS);
    }

    function onVisibilityChange() {
      if (document.hidden) {
        window.clearInterval(pollTimer);
      } else {
        void fetchUnreadCount();
        startPollTimer();
      }
    }

    startPollTimer();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initial);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(pollTimer);
    };
  }, [fetchUnreadCount]);

  // Click-outside close, matching the site-header account menu pattern.
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const markRead = React.useCallback(async (ids?: number[]) => {
    try {
      await fetch("/api/notifications/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ids ? { ids } : {}),
      });
    } catch {
      // Best-effort; badge state resyncs on the next poll/refetch.
    }
  }, []);

  const handleMarkAllRead = React.useCallback(async () => {
    await markRead();
    await fetchList();
  }, [markRead, fetchList]);

  const handleItemClick = React.useCallback(
    async (item: NotificationItem) => {
      setOpen(false);
      if (!item.read) {
        await markRead([item.id]);
      }
      if (item.reportPublicId) {
        router.push(`/report/${item.reportPublicId}`);
      }
    },
    [markRead, router],
  );

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-label="Notifications"
        onClick={() => {
          setOpen((prev) => !prev);
          // Fetch the list on open (not on close).
          if (!open) void fetchList();
        }}
        className="flex items-center gap-1.5 hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unreadCount !== null && unreadCount > 0 && (
          <span className="badge-count inline-flex items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 rounded-lg border border-border bg-card p-1 shadow-lg">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unreadCount !== null && unreadCount > 0 && (
              <button
                type="button"
                onClick={() => void handleMarkAllRead()}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Mark all read
              </button>
            )}
          </div>
          {loadingList && items === null ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">Loading…</p>
          ) : !items || items.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              No notifications yet — watch a package from the Audits page to
              get notified when its re-audit finds changes.
            </p>
          ) : (
            <ul className="max-h-80 overflow-auto">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void handleItemClick(item)}
                    className="flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-accent"
                  >
                    <span
                      className={cn(
                        "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                        item.read ? "bg-transparent" : "bg-primary",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.body}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {formatRelativeTime(item.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
