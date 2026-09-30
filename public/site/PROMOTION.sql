-- =============================================================================
-- PROMOTION.sql — مصدر واحد لهوية الدفعة (رقم الدفعة ≠ اسم الدفعة)
-- Supabase Dashboard ← SQL Editor ← الصق الملف كاملاً ← Run  (آمن للتكرار)
-- يتطلب وجود public.is_super_admin() (موجودة في NOTIFICATIONS-RPC.sql).
-- لا يمسّ أي جدول موجود (students / settings / admins ...).
-- =============================================================================

create table if not exists public.promotion_settings (
  id                int primary key default 1 check (id = 1),  -- صف وحيد
  promotion_number  int  not null default 18 check (promotion_number > 0),
  promotion_name_fr text,                                       -- NULL = لم يُحدَّد بعد
  promotion_name_ar text,                                       -- NULL = لم يُحدَّد بعد
  promotion_logo_url text,                                      -- NULL = الشعار الافتراضي
  updated_at        timestamptz not null default now(),
  updated_by        uuid references auth.users(id) on delete set null
);

-- للقواعد المنشأة سابقاً (آمن للتكرار)
alter table public.promotion_settings add column if not exists promotion_logo_url text;

-- الصف الأولي: الرقم 18، بدون أي اسم (لا نخترع اسماً).
insert into public.promotion_settings (id, promotion_number)
values (1, 18)
on conflict (id) do nothing;

-- ختم وقت/منفّذ التعديل من الخادم (لا يُؤخذ من العميل).
create or replace function public.promotion_settings_touch()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.promotion_name_fr := nullif(btrim(new.promotion_name_fr), '');
  new.promotion_name_ar := nullif(btrim(new.promotion_name_ar), '');
  return new;
end $$;

drop trigger if exists trg_promotion_settings_touch on public.promotion_settings;
create trigger trg_promotion_settings_touch
  before insert or update on public.promotion_settings
  for each row execute function public.promotion_settings_touch();

-- RLS: قراءة للجميع، تعديل للمشرف الرئيسي فقط. لا INSERT/DELETE من العميل.
alter table public.promotion_settings enable row level security;

drop policy if exists "promotion readable by everyone" on public.promotion_settings;
create policy "promotion readable by everyone"
  on public.promotion_settings for select
  to anon, authenticated using (true);

drop policy if exists "super admin can update promotion" on public.promotion_settings;
create policy "super admin can update promotion"
  on public.promotion_settings for update
  to authenticated
  using (public.is_super_admin())
  with check (public.is_super_admin());

revoke all on public.promotion_settings from anon, authenticated;
grant select on public.promotion_settings to anon, authenticated;
grant update (promotion_number, promotion_name_fr, promotion_name_ar, promotion_logo_url)
  on public.promotion_settings to authenticated;
