import NextAuth from "next-auth";
import { authConfig } from "./src/auth.config";

// Edge runtime: uses only the edge-safe config (no Prisma adapter).
export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Protect everything except API routes (preserve existing APIs), Next static
  // assets, and image/favicon. Public paths are handled in `authorized`.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
