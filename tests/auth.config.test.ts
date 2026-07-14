import { describe, it, expect } from "bun:test";
import { authConfig } from "@/auth.config";

const providers = authConfig.providers as Array<{ id: string }>;
const callbacks = authConfig.callbacks as {
  authorized?: (a: { auth?: { user?: unknown } | null; request: { nextUrl: { pathname: string } } }) => boolean;
};

describe("auth.config — Google OAuth", () => {
  it("registers the Google provider (from AUTH_GOOGLE_* env)", () => {
    const ids = providers.map((p) => p.id);
    expect(ids).toContain("google");
  });

  it("uses /login as the sign-in page", () => {
    expect((authConfig.pages as { signIn?: string })?.signIn).toBe("/login");
  });
});

describe("auth.config — middleware protection (authorized)", () => {
  const authz = callbacks.authorized!;
  const run = (path: string, loggedIn: boolean) =>
    authz({
      auth: loggedIn ? { user: { id: "u1" } } : null,
      request: { nextUrl: { pathname: path } },
    });

  it("allows the public landing page '/' when unauthenticated", () => {
    expect(run("/", false)).toBe(true);
  });

  it("allows '/login' when unauthenticated", () => {
    expect(run("/login", false)).toBe(true);
  });

  it("redirects protected '/terminal' to /login when unauthenticated", () => {
    expect(run("/terminal", false)).toBe(false);
  });

  it("allows any route when authenticated", () => {
    expect(run("/terminal", true)).toBe(true);
    expect(run("/dashboard", true)).toBe(true);
  });

  it("protects arbitrary non-public routes when unauthenticated", () => {
    expect(run("/dashboard", false)).toBe(false);
    expect(run("/admin", false)).toBe(false);
  });
});
