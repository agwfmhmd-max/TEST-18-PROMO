import { createFileRoute } from "@tanstack/react-router";
import { json } from "@/lib/iscae-server";
import { readVapidEnv } from "@/lib/iscae-push";

/**
 * المفتاح العمومي لـ VAPID فقط (ليس سرّاً) — تستعمله الواجهة
 * في PushManager.subscribe() حتى يبقى مطابقاً تماماً للمفتاح السري في الخادم.
 */
export const Route = createFileRoute("/api/public/push/vapid-key")({
  server: {
    handlers: {
      GET: async () => {
        const vapid = await readVapidEnv();
        return json({ publicKey: vapid ? vapid.publicKey : null });
      },
    },
  },
});
