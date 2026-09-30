import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./iscae-config";

/** رد JSON موحّد */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** استخراج توكن الجلسة من ترويسة Authorization */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] ?? null) : null;
}

export type AdminRow = { id: string; role: string; is_active: boolean | null };
export type AuthedCaller = { userId: string; email: string; admin: AdminRow | null };

/**
 * تحقق حقيقي من الهوية على الخادم:
 * 1) التحقق من التوكن لدى Supabase Auth.
 * 2) قراءة صف المشرف من جدول admins بصلاحيات صاحب الجلسة (RLS مفعّل).
 */
export async function authenticateCaller(
  request: Request,
): Promise<{ caller: AuthedCaller; token: string } | { error: Response }> {
  const token = bearerToken(request);
  if (!token) return { error: json({ error: "غير مصرح: لا يوجد توكن جلسة." }, 401) };

  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!userRes.ok) {
    return { error: json({ error: "جلسة غير صالحة أو منتهية. سجّل الدخول مجدداً." }, 401) };
  }
  const user = (await userRes.json()) as { id?: string; email?: string };
  if (!user.id) return { error: json({ error: "تعذر التحقق من الحساب." }, 401) };

  const adminRes = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?select=*&user_id=eq.${encodeURIComponent(user.id)}&limit=1`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } },
  );
  const rows = adminRes.ok ? ((await adminRes.json()) as AdminRow[]) : [];

  return {
    caller: { userId: user.id, email: user.email ?? "", admin: rows[0] ?? null },
    token,
  };
}

/** هل المتصل هو المشرف الرئيسي الفعّال؟ */
export function isSuperAdmin(caller: AuthedCaller): boolean {
  return !!caller.admin && caller.admin.role === "super_admin" && caller.admin.is_active !== false;
}