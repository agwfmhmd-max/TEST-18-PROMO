-- ============================================================================
-- ISCAE 18 — دوال RPC الخاصة بالإشعارات (Web Push)
-- آمن للتنفيذ المتكرر (idempotent). لا يمس أي جدول أو بيانات موجودة.
-- نفّذه في: Supabase Dashboard > SQL Editor > New query > Run
-- ============================================================================

-- ضمان أن endpoint مفتاح فريد (لمنع ازدواج الاشتراكات لنفس الجهاز)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.push_subscriptions'::regclass
      and contype = 'u'
      and conname = 'push_subscriptions_endpoint_key'
  ) then
    alter table public.push_subscriptions
      add constraint push_subscriptions_endpoint_key unique (endpoint);
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 1) هل المستخدم الحالي مشرف رئيسي؟
-- ----------------------------------------------------------------------------
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a
    where a.user_id = auth.uid()
      and a.role = 'super_admin'
      and coalesce(a.is_active, true)
  );
$$;

-- ----------------------------------------------------------------------------
-- 2) حفظ/تحديث اشتراك الجهاز (متاح للجميع — كل جهاز يحفظ اشتراكه فقط)
-- ----------------------------------------------------------------------------
create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_device_id  text default null,
  p_user_agent text default null,
  p_lang       text default 'ar'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if p_endpoint is null or p_p256dh is null or p_auth is null then
    raise exception 'endpoint/p256dh/auth are required';
  end if;

  insert into public.push_subscriptions
    (endpoint, p256dh, auth, device_id, user_agent, lang, is_active, user_id, updated_at)
  values
    (p_endpoint, p_p256dh, p_auth, p_device_id, left(coalesce(p_user_agent, ''), 300),
     coalesce(p_lang, 'ar'), true, auth.uid(), now())
  on conflict (endpoint) do update
    set p256dh     = excluded.p256dh,
        auth       = excluded.auth,
        device_id  = coalesce(excluded.device_id, public.push_subscriptions.device_id),
        user_agent = coalesce(excluded.user_agent, public.push_subscriptions.user_agent),
        lang       = coalesce(excluded.lang, public.push_subscriptions.lang),
        is_active  = true,
        user_id    = coalesce(excluded.user_id, public.push_subscriptions.user_id),
        updated_at = now()
  returning id into v_id;

  return v_id;
end $$;

-- ----------------------------------------------------------------------------
-- 3) عدد الأجهزة المفعّلة (المشرف الرئيسي فقط)
-- ----------------------------------------------------------------------------
create or replace function public.count_active_push_subscriptions()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  return (select count(*)::int from public.push_subscriptions where is_active);
end $$;

-- ----------------------------------------------------------------------------
-- 4) جلب الأجهزة المفعّلة للإرسال (المشرف الرئيسي فقط)
-- ----------------------------------------------------------------------------
create or replace function public.get_active_push_subscriptions()
returns table (id uuid, endpoint text, p256dh text, auth text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  return query
    select s.id, s.endpoint, s.p256dh, s.auth
    from public.push_subscriptions s
    where s.is_active
      and s.endpoint is not null
      and s.p256dh is not null
      and s.auth is not null;
end $$;

-- ----------------------------------------------------------------------------
-- 5) حذف الاشتراكات المنتهية 404/410 (المشرف الرئيسي فقط)
-- ----------------------------------------------------------------------------
create or replace function public.delete_push_subscriptions(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  if not public.is_super_admin() then
    raise exception 'forbidden';
  end if;
  delete from public.push_subscriptions where id = any(p_ids);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ----------------------------------------------------------------------------
-- 6) الصلاحيات
-- ----------------------------------------------------------------------------
revoke all on function public.save_push_subscription(text, text, text, text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text, text, text, text)
  to anon, authenticated, service_role;

revoke all on function public.count_active_push_subscriptions() from public;
grant execute on function public.count_active_push_subscriptions() to authenticated, service_role;

revoke all on function public.get_active_push_subscriptions() from public;
grant execute on function public.get_active_push_subscriptions() to authenticated, service_role;

revoke all on function public.delete_push_subscriptions(uuid[]) from public;
grant execute on function public.delete_push_subscriptions(uuid[]) to authenticated, service_role;

grant execute on function public.is_super_admin() to anon, authenticated, service_role;
