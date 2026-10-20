"use client";

/**
 * Browser-side helper for calling routes gated by lib/admin-guard.ts's
 * requireAdminKey. This is a demo-grade convenience, not a secrets
 * manager: the key is cached in sessionStorage (cleared when the tab
 * closes) so the operator isn't re-prompted on every single admin
 * action in a session, and is cleared automatically the moment a 401
 * comes back so a stale/wrong cached key doesn't loop forever.
 */

import { ADMIN_KEY_HEADER } from "./admin-guard";

const STORAGE_KEY = "atlas_admin_key";

export function getOrPromptAdminKey(): string | null {
  if (typeof window === "undefined") return null;
  let key = window.sessionStorage.getItem(STORAGE_KEY);
  if (!key) {
    key = window.prompt("Enter the ATLAS admin key to continue with this action:");
    if (!key) return null;
    window.sessionStorage.setItem(STORAGE_KEY, key);
  }
  return key;
}

export function clearStoredAdminKey(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}

export async function adminFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const key = getOrPromptAdminKey();
  if (!key) {
    throw new Error("Admin key is required for this action.");
  }
  const headers = new Headers(init.headers);
  headers.set(ADMIN_KEY_HEADER, key);
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    // Stale or wrong cached key -- clear it so the next attempt re-prompts
    // instead of silently retrying the same bad value forever.
    clearStoredAdminKey();
  }
  return res;
}
