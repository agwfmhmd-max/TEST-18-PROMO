-- ISCAE promotion identity migration
-- Apply this migration in Supabase SQL Editor before using the bilingual promotion editor.
-- Existing student, auth, notification, ceremony and settings data is preserved.

alter table public.settings add column if not exists promotion_number integer not null default 18;
alter table public.settings add column if not exists promotion_name_fr text null;
alter table public.settings add column if not exists promotion_name_ar text null;

update public.settings set promotion_number = 18 where id = 1 and promotion_number is null;

-- Keep the existing settings RLS policies. The existing administrator update policy
-- should remain the only policy that permits UPDATE; public users only need SELECT.
-- Do not add a service-role key to the client.
