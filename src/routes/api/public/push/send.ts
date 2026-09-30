import { createFileRoute } from "@tanstack/react-router";
import { authenticateCaller, isSuperAdmin, json } from "@/lib/iscae-server";
import {
  assertVapidUsable,
  endpointLabel,
  readVapidEnv,
  sendPushNotification,
  type StoredPushSubscription,
  type VapidKeys,
} from "@/lib/iscae-push";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/iscae-config";

const MAX_TITLE = 120;
const MAX_BODY = 500;
const CONCURRENCY = 10;

type NotificationRow = { id: string };

type PushError = { endpoint: string; status: number | null; error: string };

function restHeaders(token: string, extra: Record<string, string> = {}) {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, ...extra };
}

/** تسجيل الإشعار (يُشغّل أيضاً الإشعار الداخلي الفوري عبر Realtime) */
async function insertNotification(
  row: { title: string; body: string; url: string | null; created_by: string | null },
  token: string,
): Promise<NotificationRow | null> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
    method: "POST",
    headers: restHeaders(token, {
      "content-type": "application/json",
      Prefer: "return=representation",
    }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    console.error("[Push] insert notification failed:", res.status);
    return null;
  }
  const rows = (await res.json()) as NotificationRow[];
  return rows[0] ?? null;
}

async function updateNotificationStats(
  id: string,
  stats: { success_count: number; failure_count: number },
  token: string,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/notifications?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: restHeaders(token, { "content-type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify({ ...stats, sent_at: new Date().toISOString() }),
  }).catch(() => null);
}

/** كل الأجهزة المفعّلة عبر RPC (متاحة للمشرف الرئيسي فقط بحسب SQL) */
async function fetchActiveSubscriptions(
  token: string,
): Promise<{ subs: StoredPushSubscription[]; error: string | null }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_active_push_subscriptions`, {
    method: "POST",
    headers: restHeaders(token, { "content-type": "application/json" }),
    body: "{}",
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    console.error("[Push] get_active_push_subscriptions failed:", res.status, text);
    return { subs: [], error: `RPC get_active_push_subscriptions: ${res.status} ${text}` };
  }
  const rows = (await res.json()) as StoredPushSubscription[];
  return { subs: Array.isArray(rows) ? rows : [], error: null };
}

async function deleteSubscriptions(ids: string[], token: string): Promise<void> {
  if (ids.length === 0) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/delete_push_subscriptions`, {
    method: "POST",
    headers: restHeaders(token, { "content-type": "application/json" }),
    body: JSON.stringify({ p_ids: ids }),
  }).catch(() => null);
  if (!res || !res.ok) console.error("[Push] delete_push_subscriptions failed");
}

/** إرسال مستقل لكل جهاز، على دفعات صغيرة — فشل جهاز لا يوقف البقية */
async function sendToAll(
  subs: StoredPushSubscription[],
  payload: { id: string | null; title: string; body: string; url?: string },
  vapid: VapidKeys,
): Promise<{ delivered: number; failed: number; goneIds: string[]; errors: PushError[] }> {
  let delivered = 0;
  let failed = 0;
  const goneIds: string[] = [];
  const errors: PushError[] = [];

  for (let i = 0; i < subs.length; i += CONCURRENCY) {
    const batch = subs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (sub) => ({ sub, result: await sendPushNotification(sub, payload, vapid) })),
    );
    for (const { sub, result } of results) {
      if (result.outcome === "ok") {
        delivered += 1;
      } else if (result.outcome === "gone") {
        goneIds.push(sub.id);
      } else {
        failed += 1;
        errors.push({
          endpoint: endpointLabel(sub.endpoint),
          status: result.status,
          error: (result.error ?? "unknown error").slice(0, 200),
        });
      }
    }
  }

  return { delivered, failed, goneIds, errors };
}

/**
 * إرسال إشعار من المشرف الرئيسي إلى كل الأجهزة المفعّلة.
 * كل شيء داخل خادم الموقع (Cloudflare Worker) — بدون Edge Functions وبدون Node.
 */
export const Route = createFileRoute("/api/public/push/send")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const auth = await authenticateCaller(request);
        if ("error" in auth) return auth.error;
        const { caller, token } = auth;

        if (!isSuperAdmin(caller)) {
          return json({ ok: false, error: "❌ إرسال الإشعارات متاح للمشرف الرئيسي فقط." }, 403);
        }

        const vapid = await readVapidEnv();
        if (!vapid) {
          console.error("[Push] VAPID env missing on server");
          return json(
            {
              ok: false,
              error:
                "❌ VAPID configuration error: مفاتيح VAPID غير متوفرة على الخادم (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).",
            },
            500,
          );
        }
        try {
          await assertVapidUsable(vapid);
        } catch (err) {
          const message = err instanceof Error ? err.message : "invalid VAPID keys";
          console.error("[Push] VAPID keys unusable:", message);
          return json(
            { ok: false, error: `❌ VAPID configuration error: ${message}` },
            500,
          );
        }

        let payload: Record<string, unknown>;
        try {
          payload = (await request.json()) as Record<string, unknown>;
        } catch {
          return json({ ok: false, error: "❌ طلب غير صالح." }, 400);
        }

        const title = String(payload["title"] ?? "")
          .trim()
          .slice(0, MAX_TITLE);
        const body = String(payload["body"] ?? "")
          .trim()
          .slice(0, MAX_BODY);
        const rawUrl = String(payload["url"] ?? "")
          .trim()
          .slice(0, 500);
        if (!title || !body) return json({ ok: false, error: "❌ العنوان والنص مطلوبان." }, 400);

        const urlOk =
          !rawUrl || /^https?:\/\//i.test(rawUrl) || rawUrl.startsWith("./") || rawUrl.startsWith("#");
        const url = urlOk && rawUrl && rawUrl !== "null" ? rawUrl : null;

        const notif = await insertNotification(
          { title, body, url, created_by: caller.admin ? caller.admin.id : null },
          token,
        );

        const { subs, error: subsError } = await fetchActiveSubscriptions(token);
        if (subsError) {
          return json({ ok: false, sent: 0, failed: 0, removed: 0, error: `❌ ${subsError}` }, 500);
        }

        console.log(`[Push] subscriptions count: ${subs.length}`);

        if (subs.length === 0) {
          if (notif)
            await updateNotificationStats(notif.id, { success_count: 0, failure_count: 0 }, token);
          return json({
            ok: true,
            id: notif ? notif.id : null,
            total: 0,
            sent: 0,
            failed: 0,
            removed: 0,
            message: "لا يوجد مشتركون في الإشعارات حالياً.",
          });
        }

        const { delivered, failed, goneIds, errors } = await sendToAll(
          subs,
          { id: notif ? notif.id : null, title, body, ...(url ? { url } : {}) },
          vapid,
        );

        await deleteSubscriptions(goneIds, token);
        if (notif) {
          await updateNotificationStats(
            notif.id,
            { success_count: delivered, failure_count: failed },
            token,
          );
        }

        console.log(
          `[Push] done — total:${subs.length} sent:${delivered} failed:${failed} removed:${goneIds.length}`,
        );

        const ok = delivered > 0 || (failed === 0 && errors.length === 0);
        return json(
          {
            ok,
            id: notif ? notif.id : null,
            total: subs.length,
            sent: delivered,
            failed,
            removed: goneIds.length,
            ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
            ...(ok
              ? {}
              : { error: `❌ فشل إرسال جميع الإشعارات: ${errors[0]?.error ?? "سبب غير معروف"}` }),
          },
          ok ? 200 : 502,
        );
      },
    },
  },
});
