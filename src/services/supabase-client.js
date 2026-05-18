import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getSupabaseConfig } from "../config.js";

let clientPromise = null;

export function getSupabaseClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const cfg = await getSupabaseConfig();
      if (!cfg) {
        throw new Error("supabase_not_configured");
      }
      return createClient(cfg.url, cfg.key, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    })();
  }
  return clientPromise;
}

export function resetSupabaseClient() {
  clientPromise = null;
}
