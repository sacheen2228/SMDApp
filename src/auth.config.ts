import type { NextAuthConfig } from "next-auth";
import Google from "next-auth/providers/google";

// Edge-safe config (NO Prisma adapter here) — imported by middleware.ts.
// The full config (with adapter) lives in src/auth.ts.
export const authConfig = {
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  pages: {
    signIn: "/login",
  },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic =
        nextUrl.pathname === "/" || nextUrl.pathname === "/login";
      if (isPublic) return true;
      // Protected routes require a session; otherwise redirect to /login.
      return isLoggedIn;
    },
  },
} satisfies NextAuthConfig;
