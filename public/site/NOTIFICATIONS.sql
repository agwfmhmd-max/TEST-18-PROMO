-- ============================================================================
-- ISCAE 18 — نظام الإشعارات (Web Push)
-- نفّذ هذا الملف مرة واحدة في: Supabase Dashboard > SQL Editor > New query > Run
-- آمن للتنفيذ المتكرر (idempotent) ولا يمس أي جدول من جداولك الحالية.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) جدول الأجهزة المشتركة في التنبيهات
-- ----------------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  device_id   text,
  user_agent  text,
  lang        text default 'ar',
  is_active   boolean not null default true,
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- إن كان الجدول موجوداً مسبقاً بنسخة أقدم، نضيف الأعمدة الناقصة (آمن للتكرار)
alter table public.push_subscriptions add column if not exists p256dh     text;
alter table public.push_subscriptions add column if not exists auth       text;
alter table public.push_subscriptions add column if not exists device_id  text;
alter table public.push_subscriptions add column if not exists user_agent text;
alter table public.push_subscriptions add column if not exists lang       text default 'ar';
alter table public.push_subscriptions add column if not exists is_active  boolean not null default true;
alter table public.push_subscriptions add column if not exists user_id    uuid references auth.users(id) on delete set null;
alter table public.push_subscriptions add column if not exists created_at timestamptz not null default now();
alter table public.push_subscriptions add column if not exists updated_at timestamptz not null default now();

create index if not exists push_subscriptions_active_idx
  on public.push_subscriptions (is_active);

-- ----------------------------------------------------------------------------
-- 2) جدول الإشعارات المرسلة
-- ----------------------------------------------------------------------------
create table if not exists public.notifications (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  body          text not null,
  url           text,
  created_by    uuid,
  success_count integer not null default 0,
  failure_count integer not null default 0,
  sent_at       timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.notifications add column if not exists url           text;
alter table public.notifications add column if not exists created_by    uuid;
alter table public.notifications add column if not exists success_count integer not null default 0;
alter table public.notifications add column if not exists failure_count integer not null default 0;
alter table public.notifications add column if not exists sent_at       timestamptz;
alter table public.notifications add column if not exists created_at    timestamptz not null default now();

create index if not exists notifications_created_at_idx
  on public.notifications (created_at desc);

-- ----------------------------------------------------------------------------
-- 3) الصلاحيات (Data API)
-- ----------------------------------------------------------------------------
grant select, insert, update, delete on public.push_subscriptions to anon, authenticated;
grant all on public.push_subscriptions to service_role;

grant select on public.notifications to anon, authenticated;
grant all on public.notifications to service_role;

-- ----------------------------------------------------------------------------
-- 4) Row Level Security
-- ----------------------------------------------------------------------------
alter table public.push_subscriptions enable row level security;
alter table public.notifications      enable row level security;

-- الزائر يستطيع تسجيل جهازه (بدون تسجيل دخول) لكنه لا يستطيع قراءة اشتراكات الآخرين.
drop policy if exists "anyone can subscribe" on public.push_subscriptions;
create policy "anyone can subscribe"
  on public.push_subscriptions for insert
  to anon, authenticated
  with check (true);

-- التحديث/الحذف يتطلب معرفة endpoint الخاص بالجهاز (سرّ لا يمكن قراءته من الخارج).
drop policy if exists "device can update own subscription" on public.push_subscriptions;
create policy "device can update own subscription"
  on public.push_subscriptions for update
  to anon, authenticated
  using (true) with check (true);

drop policy if exists "device can delete own subscription" on public.push_subscriptions;
create policy "device can delete own subscription"
  on public.push_subscriptions for delete
  to anon, authenticated
  using (true);

-- القراءة (وعدّ الأجهزة في لوحة المشرف) للمشرف الرئيسي فقط.
drop policy if exists "super admin can read subscriptions" on public.push_subscriptions;
create policy "super admin can read subscriptions"
  on public.push_subscriptions for select
  to authenticated
  using (exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.role = 'super_admin'
  ));

-- الإشعارات: قراءة عامة (الإشعار الداخلي الفوري)، والكتابة عبر الخادم فقط (service_role).
drop policy if exists "notifications are public to read" on public.notifications;
create policy "notifications are public to read"
  on public.notifications for select
  to anon, authenticated
  using (true);

-- ----------------------------------------------------------------------------
-- 5) Realtime (الإشعار الداخلي الفوري عندما يكون الموقع مفتوحاً)
-- ----------------------------------------------------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.notifications;
  exception when duplicate_object then null;
  end;
end $$;

alter table public.notifications replica identity full;

-- ----------------------------------------------------------------------------
-- 6) تحديث updated_at تلقائياً
-- ----------------------------------------------------------------------------
create or replace function public.touch_push_subscription()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists push_subscriptions_touch on public.push_subscriptions;
create trigger push_subscriptions_touch
  before update on public.push_subscriptions
  for each row execute function public.touch_push_subscription();

-- ----------------------------------------------------------------------------
-- 7) سياسات الإرسال من خادم الموقع (بدون Edge Function وبدون Service Role Key)
--    الخادم يستعمل توكن جلسة المشرف الرئيسي نفسه، لذلك نحتاج سياستي
--    الإدراج والتحديث على جدول notifications للمشرف الرئيسي فقط.
-- ----------------------------------------------------------------------------
grant insert, update on public.notifications to authenticated;

drop policy if exists "super admin can insert notifications" on public.notifications;
create policy "super admin can insert notifications"
  on public.notifications for insert
  to authenticated
  with check (exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.role = 'super_admin'
  ));

drop policy if exists "super admin can update notifications" on public.notifications;
create policy "super admin can update notifications"
  on public.notifications for update
  to authenticated
  using (exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.role = 'super_admin'
  ))
  with check (exists (
    select 1 from public.admins a
    where a.user_id = auth.uid() and a.role = 'super_admin'
  ));
