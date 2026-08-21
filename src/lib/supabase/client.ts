import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser Supabase client, using the public "anon" key. This key is safe to
 * expose to the client - access is controlled by the Row Level Security
 * policies defined in supabase/schema.sql, not by keeping this key secret.
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
