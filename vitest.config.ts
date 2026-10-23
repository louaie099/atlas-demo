import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    // This whole suite calls app/api/* route handlers directly (never
    // through a real Next.js server, so there's no real Supabase Auth
    // session to have), and relies on the x-atlas-role header to exercise
    // each role's behavior -- exactly the old getRoleFromHeader mechanism.
    // Opting in to the demo-header fallback here, in the test environment
    // ONLY, keeps every existing role-boundary test meaningful without
    // reintroducing it as a real option anywhere else: see
    // lib/resolve-role.ts and docs/known-limitations/auth-and-rls.md.
    env: {
      ATLAS_ALLOW_DEMO_ROLE_HEADER: "true",
    },
  },
});
