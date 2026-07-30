import { createClient } from "@supabase/supabase-js";
const url=import.meta.env.VITE_SUPABASE_URL;const key=import.meta.env.VITE_SUPABASE_ANON_KEY;
if(!url||!key)console.warn("Supabase environment variables are not configured.");
export const supabase=createClient(url||"https://placeholder.supabase.co",key||"placeholder",{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
