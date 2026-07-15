"use client";

import { createBrowserClient } from "@supabase/ssr";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

// One browser client for the whole app (cookie-based session, shared with the
// middleware so RLS applies as the signed-in user everywhere).
let client: ReturnType<typeof createBrowserClient> | null = null;

export function getSupabase() {
  if (!client) client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}
