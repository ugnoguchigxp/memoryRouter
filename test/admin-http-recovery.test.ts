import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminApiError,
  createAdminSession,
  fetchAdminSessionStatus,
  getJson,
  requestForm,
  requestJson,
} from "../web/src/modules/admin/repositories/admin/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin HTTP recovery", () => {
  it("can inspect status and sign in after a rejected bootstrap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(Response.json({ configured: true, authenticated: false }))
      .mockResolvedValueOnce(Response.json({ ok: true }))
      .mockResolvedValueOnce(Response.json({ items: ["saved"] }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__MEMORY_ROUTER_ADMIN_API_KEY__", "expired-key");
    await expect(getJson("/api/knowledge")).rejects.toMatchObject({ status: 401 });
    await expect(fetchAdminSessionStatus()).resolves.toMatchObject({ authenticated: false });
    await createAdminSession("correct-key");
    await expect(getJson("/api/knowledge")).resolves.toEqual({ items: ["saved"] });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      (globalThis as { __MEMORY_ROUTER_ADMIN_API_KEY__?: unknown }).__MEMORY_ROUTER_ADMIN_API_KEY__,
    ).toBeUndefined();
  });

  it("shares a pending bootstrap between concurrent reads", async () => {
    let finish!: (response: Response) => void;
    const fetchMock = vi.fn().mockImplementation((url) =>
      url === "/api/admin-session"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json({ ok: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("__MEMORY_ROUTER_ADMIN_API_KEY__", "shared-key");
    const first = getJson("/api/knowledge");
    const second = getJson("/api/sources");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(Response.json({ ok: true }));
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["json", "form"])(
    "preserves structured %s mutation errors without retrying",
    async (kind) => {
      const payload = { error: { code: "revision_conflict", message: "Reload before saving" } };
      const fetchMock = vi.fn().mockResolvedValue(Response.json(payload, { status: 409 }));
      vi.stubGlobal("fetch", fetchMock);
      const result =
        kind === "json"
          ? requestJson("/api/sources/1", "PATCH", { title: "new" })
          : requestForm("/api/sources/import", "POST", new FormData());
      await expect(result).rejects.toBeInstanceOf(AdminApiError);
      await expect(result).rejects.toMatchObject({
        status: 409,
        code: "revision_conflict",
        message: "Reload before saving",
        payload,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a mutation's specific reason ahead of its generic error label", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "conflict", reason: "Revision changed. Reload this page." },
            { status: 409 },
          ),
        ),
    );
    await expect(requestJson("/api/sources/1", "PATCH", {})).rejects.toMatchObject({
      status: 409,
      message: "Revision changed. Reload this page.",
    });
  });

  it("keeps conflict outcome messages compatible and handles non-JSON failures", async () => {
    const payload = { outcome: "conflict", reason: "stale" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(payload, { status: 409 }))
        .mockResolvedValueOnce(new Response("Bad gateway", { status: 502 })),
    );
    await expect(requestJson("/api/sources/1", "PATCH", {})).rejects.toMatchObject({
      message: JSON.stringify(payload),
      payload,
    });
    await expect(requestJson("/api/sources/1", "PATCH", {})).rejects.toMatchObject({
      status: 502,
      payload: null,
    });
  });
});
