import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { DEFAULT_ADMIN_API_KEY } from "../../../../../src/shared/admin-api-key";
import {
  ADMIN_SESSION_EXPIRED_EVENT,
  createAdminSession,
  deleteAdminSession,
  fetchAdminSessionStatus,
} from "../repositories/admin.repository";

const navItems = [
  { to: "/", label: "Overview" },
  { to: "/sources", label: "Source" },
  { to: "/vibe-memory", label: "Vibe Memory" },
  { to: "/episodes", label: "Episodes" },
  { to: "/candidates", label: "Candidates" },
  { to: "/queue", label: "Queue" },
  { to: "/knowledge", label: "Knowledge" },
  { to: "/landscape", label: "Landscape" },
  { to: "/graph", label: "Graph" },
  { to: "/compile", label: "Compile" },
  { to: "/decision", label: "Decision" },
  { to: "/audit", label: "Audit" },
  { to: "/doctor", label: "Doctor" },
  { to: "/setting", label: "Settings" },
] as const;

export function AppShell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [sessionState, setSessionState] = useState<
    "loading" | "authenticated" | "unauthenticated" | "unconfigured"
  >("loading");
  const [apiKey, setApiKey] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchAdminSessionStatus()
      .then(async (status) => {
        if (!active) return;
        setConfigurationError(status.configurationError);
        if (status.configured && !status.authenticated) {
          try {
            await createAdminSession(DEFAULT_ADMIN_API_KEY);
            if (active) setSessionState("authenticated");
            return;
          } catch {
            // A custom environment key is configured; show the regular login form.
          }
        }
        if (!active) return;
        setSessionState(
          status.authenticated
            ? "authenticated"
            : status.configured
              ? "unauthenticated"
              : "unconfigured",
        );
      })
      .catch((error) => {
        if (!active) return;
        setSessionState("unauthenticated");
        setSessionError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handleExpiredSession = () => {
      setSessionError("The admin session expired. Enter the current key to continue.");
      setSessionState("unauthenticated");
    };
    window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpiredSession);
    return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT, handleExpiredSession);
  }, []);

  const submitSession = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSessionError(null);
    try {
      await createAdminSession(apiKey);
      setApiKey("");
      setSessionState("authenticated");
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : String(error));
    }
  };

  const logout = async () => {
    try {
      await deleteAdminSession();
    } finally {
      setSessionState("unauthenticated");
    }
  };

  if (sessionState !== "authenticated") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <section className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
          <h1 className="text-xl font-semibold">contextStill Admin</h1>
          {sessionState === "loading" ? (
            <p className="mt-3 text-sm text-muted-foreground">Checking admin session…</p>
          ) : sessionState === "unconfigured" ? (
            <div className="mt-3 space-y-2 text-sm">
              <p>The admin API is locked because no API key is configured.</p>
              <p className="text-muted-foreground">
                {configurationError === "admin_api_key_too_short"
                  ? "CONTEXT_STILL_ADMIN_API_KEY must contain at least 32 characters. Replace it with a strong random value and restart the API."
                  : "Set CONTEXT_STILL_ADMIN_API_KEY to a strong random value of at least 32 characters and restart the API."}
              </p>
            </div>
          ) : (
            <form className="mt-4 space-y-3" onSubmit={submitSession}>
              <label className="block text-sm font-medium" htmlFor="admin-api-key">
                Admin API key
              </label>
              <input
                id="admin-api-key"
                type="password"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                minLength={32}
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                required
              />
              <button
                type="submit"
                className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              >
                Start session
              </button>
            </form>
          )}
          {sessionError ? <p className="mt-3 text-sm text-destructive">{sessionError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <header className="app-nav">
        <div className="brand-block">
          <span className="brand-title">contextStill</span>
        </div>
        <nav className="nav-links" aria-label="main navigation">
          {navItems.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-link ${
                item.to === "/setting"
                  ? pathname.startsWith("/setting") || pathname.startsWith("/settings")
                    ? "active"
                    : ""
                  : pathname === item.to
                    ? "active"
                    : ""
              }`}
            >
              {item.label}
            </Link>
          ))}
          <button type="button" className="nav-link" onClick={logout}>
            Sign out
          </button>
        </nav>
      </header>
      <main
        className={`app-content ${
          pathname === "/" ||
          pathname.startsWith("/compile") ||
          pathname.startsWith("/decision") ||
          pathname.startsWith("/vibe-memory") ||
          pathname.startsWith("/episodes") ||
          pathname.startsWith("/sources") ||
          pathname.startsWith("/graph") ||
          pathname.startsWith("/landscape") ||
          pathname.startsWith("/knowledge") ||
          pathname.startsWith("/candidates") ||
          pathname.startsWith("/queue") ||
          pathname.startsWith("/audit") ||
          pathname.startsWith("/doctor") ||
          pathname.startsWith("/setting") ||
          pathname.startsWith("/settings")
            ? "full-width"
            : ""
        }`}
      >
        <Outlet />
      </main>
    </div>
  );
}
