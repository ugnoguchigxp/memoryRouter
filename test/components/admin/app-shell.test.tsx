/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../../web/src/modules/admin/components/app-shell";

const sessionMocks = vi.hoisted(() => ({
  ADMIN_SESSION_EXPIRED_EVENT: "context-still:admin-session-expired",
  createAdminSession: vi.fn(),
  deleteAdminSession: vi.fn(),
  fetchAdminSessionStatus: vi.fn(),
}));

vi.mock("../../../web/src/modules/admin/repositories/admin.repository", () => sessionMocks);

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: any) => <a href="/">{children}</a>,
  useRouterState: vi.fn().mockReturnValue("/test"),
  Outlet: () => <div>outlet-content</div>,
}));

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionMocks.createAdminSession.mockResolvedValue(undefined);
    sessionMocks.deleteAdminSession.mockResolvedValue(undefined);
    sessionMocks.fetchAdminSessionStatus.mockResolvedValue({
      configured: true,
      authenticated: true,
      configurationError: null,
    });
  });

  it("renders with navigation", async () => {
    render(<AppShell />);
    expect(await screen.findByText("outlet-content")).toBeInTheDocument();
    const labels = screen.getByLabelText("main navigation").textContent ?? "";
    expect(labels.indexOf("Graph")).toBeLessThan(labels.indexOf("Compile"));
    expect(labels.indexOf("Compile")).toBeLessThan(labels.indexOf("Audit"));
    expect(labels.indexOf("Doctor")).toBeLessThan(labels.indexOf("Settings"));
  });

  it("keeps the admin key in the login form only long enough to create a session", async () => {
    sessionMocks.fetchAdminSessionStatus.mockResolvedValue({
      configured: true,
      authenticated: false,
      configurationError: null,
    });
    sessionMocks.createAdminSession
      .mockRejectedValueOnce(new Error("unauthorized"))
      .mockResolvedValueOnce(undefined);
    render(<AppShell />);

    const input = await screen.findByLabelText("Admin API key");
    const apiKey = "typed-admin-key-0123456789abcdef0123456789abcdef";
    fireEvent.change(input, { target: { value: apiKey } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(await screen.findByText("outlet-content")).toBeInTheDocument();
    expect(sessionMocks.createAdminSession).toHaveBeenCalledWith(apiKey);
  });

  it("automatically creates a session with the local default key", async () => {
    sessionMocks.fetchAdminSessionStatus.mockResolvedValue({
      configured: true,
      authenticated: false,
      configurationError: null,
    });
    render(<AppShell />);

    expect(await screen.findByText("outlet-content")).toBeInTheDocument();
    expect(sessionMocks.createAdminSession).toHaveBeenCalledWith(
      "context-still-local-admin-api-key-2026",
    );
  });

  it("shows the login form when the configured environment key overrides the default", async () => {
    sessionMocks.fetchAdminSessionStatus.mockResolvedValue({
      configured: true,
      authenticated: false,
      configurationError: null,
    });
    sessionMocks.createAdminSession.mockRejectedValue(new Error("unauthorized"));
    render(<AppShell />);

    expect(await screen.findByLabelText("Admin API key")).toBeInTheDocument();
  });

  it("returns to login when an API request reports an expired session", async () => {
    render(<AppShell />);
    expect(await screen.findByText("outlet-content")).toBeInTheDocument();

    fireEvent(window, new Event(sessionMocks.ADMIN_SESSION_EXPIRED_EVENT));

    expect(await screen.findByLabelText("Admin API key")).toBeInTheDocument();
    expect(screen.getByText(/admin session expired/i)).toBeInTheDocument();
  });
});
