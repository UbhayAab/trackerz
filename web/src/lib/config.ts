// Supabase connection. Prod defaults are baked in (the anon key is safe in the
// client because every user table has RLS), so the app runs with no env set;
// override via NEXT_PUBLIC_* to point a fork at another project.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://yyoewdcijplkhxleejtm.supabase.co";

export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  "sb_publishable_0AfWy1NnROvjW0P0Cj3KVA_m286sLXT";

export const RAW_MEDIA_BUCKET = "raw-media";
