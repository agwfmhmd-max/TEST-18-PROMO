/**
 * Web Push (RFC 8291 / aes128gcm + VAPID RFC 8292) بواسطة Web Crypto فقط.
 * يعمل داخل Cloudflare Worker (بدون مكتبات Node وبدون Edge Functions).
 *
 * ملاحظة مهمة: كانت النسخة السابقة ترسل بترميز "aesgcm" القديم مع ترويسة
 * `Authorization: WebPush <jwt>` (المسودة القديمة)، وهي مرفوضة أو غير موثوقة
 * لدى عدة خدمات Push حديثة. هذه النسخة تستعمل الترميز القياسي aes128gcm
 * وترويسة `Authorization: vapid t=<jwt>,k=<publicKey>`.
 */

export type VapidKeys = {
  subject: string;
  publicKey: string;
  privateKey: string;
};

/** اشتراك جهاز كما هو مخزَّن في جدول push_subscriptions */
export type StoredPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushNotificationPayload = {
  id?: string | null;
  title: string;
  body: string;
  url?: string;
  icon?: string;
  badge?: string;
};

export type PushSendResult = {
  outcome: "ok" | "gone" | "error";
  status: number | null;
  /** رسالة مختصرة للتشخيص (بدون أي أسرار) */
  error?: string;
};

/* ------------------------------------------------------------------ */
/* أدوات Base64URL                                                     */
/* ------------------------------------------------------------------ */

function b64urlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i] as number);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* قراءة أسرار VAPID من بيئة التشغيل (Cloudflare / Nitro / Node)       */
/* ------------------------------------------------------------------ */

function readEnvVar(name: string): string | undefined {
  const globalAny = globalThis as unknown as Record<string, unknown>;
  const candidates: Array<unknown> = [
    typeof process !== "undefined" ? (process as { env?: unknown }).env : undefined,
    globalAny["__env__"],
    globalAny["env"],
    (globalAny["process"] as { env?: unknown } | undefined)?.env,
  ];
  for (const source of candidates) {
    if (source && typeof source === "object") {
      const value = (source as Record<string, unknown>)[name];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  return undefined;
}

/** يقرأ مفاتيح VAPID من أسرار الخادم (داخل المعالج فقط — لا في نطاق الوحدة) */
export async function readVapidEnv(): Promise<VapidKeys | null> {
  let publicKey = readEnvVar("VAPID_PUBLIC_KEY");
  let privateKey = readEnvVar("VAPID_PRIVATE_KEY");
  let subject = readEnvVar("VAPID_SUBJECT");

  if (!publicKey || !privateKey) {
    // بيئة Cloudflare Workers: الأسرار متاحة عبر ربط env
    try {
      const specifier = "cloudflare:workers";
      const mod = (await import(/* @vite-ignore */ specifier)) as {
        env?: Record<string, string | undefined>;
      };
      const cfEnv = mod.env;
      if (cfEnv) {
        publicKey = publicKey || cfEnv["VAPID_PUBLIC_KEY"];
        privateKey = privateKey || cfEnv["VAPID_PRIVATE_KEY"];
        subject = subject || cfEnv["VAPID_SUBJECT"];
      }
    } catch {
      /* ليست بيئة Cloudflare — نتجاهل */
    }
  }

  if (!publicKey || !privateKey) return null;
  return {
    subject: subject || "mailto:admin@iscae.mr",
    publicKey: publicKey.trim(),
    privateKey: privateKey.trim(),
  };
}

/* ------------------------------------------------------------------ */
/* VAPID JWT (ES256)                                                   */
/* ------------------------------------------------------------------ */

async function importVapidSigningKey(vapid: VapidKeys): Promise<CryptoKey> {
  const publicBytes = b64urlToBytes(vapid.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error("VAPID public key is not a valid uncompressed P-256 key");
  }
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64url(publicBytes.slice(1, 33)),
      y: bytesToB64url(publicBytes.slice(33, 65)),
      d: vapid.privateKey,
      ext: true,
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/** يتحقق من صلاحية المفاتيح وتطابق العام مع السري (الاستيراد يفشل عند عدم التطابق). */
export async function assertVapidUsable(vapid: VapidKeys): Promise<void> {
  await importVapidSigningKey(vapid);
}

async function vapidAuthorization(endpoint: string, vapid: VapidKeys): Promise<string> {
  const key = await importVapidSigningKey(vapid);
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: vapid.subject,
  };
  const encoder = new TextEncoder();
  const signingInput = `${bytesToB64url(encoder.encode(JSON.stringify(header)))}.${bytesToB64url(
    encoder.encode(JSON.stringify(claims)),
  )}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(signingInput),
  );
  return `vapid t=${signingInput}.${bytesToB64url(signature)},k=${vapid.publicKey}`;
}

/* ------------------------------------------------------------------ */
/* تشفير الحمولة (RFC 8291 — aes128gcm)                                */
/* ------------------------------------------------------------------ */

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data as unknown as BufferSource);
  return new Uint8Array(sig);
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const okm = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

async function encryptPayload(
  p256dh: string,
  authSecret: string,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const uaPublicBytes = b64urlToBytes(p256dh);
  const authBytes = b64urlToBytes(authSecret);
  if (uaPublicBytes.length !== 65) throw new Error("invalid p256dh length");
  if (authBytes.length < 16) throw new Error("invalid auth secret length");

  const uaPublicKey = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes as unknown as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const localKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const localPublicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", localKeys.publicKey));

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, localKeys.privateKey, 256),
  );

  const encoder = new TextEncoder();
  const keyInfo = concatBytes(
    encoder.encode("WebPush: info\0"),
    uaPublicBytes,
    localPublicBytes,
  );
  const ikm = await hkdf(authBytes, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek as unknown as BufferSource,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  // حشوة نهاية السجل الإلزامية (0x02 = آخر سجل)
  const padded = concatBytes(plaintext, new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as unknown as BufferSource },
      aesKey,
      padded as unknown as BufferSource,
    ),
  );

  const recordSize = 4096;
  const header = new Uint8Array(16 + 4 + 1 + localPublicBytes.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = localPublicBytes.length;
  header.set(localPublicBytes, 21);

  return concatBytes(header, ciphertext);
}

/* ------------------------------------------------------------------ */
/* الإرسال                                                             */
/* ------------------------------------------------------------------ */

/** بصمة مختصرة للـ endpoint للتسجيل الآمن (بدون كشف العنوان الكامل) */
export function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}/…${endpoint.slice(-8)}`;
  } catch {
    return "invalid-endpoint";
  }
}

export function buildPushBody(payload: PushNotificationPayload): string {
  return JSON.stringify({
    id: payload.id ?? null,
    title: payload.title,
    body: payload.body,
    url: payload.url && payload.url.trim() !== "" ? payload.url : "/site/index.html",
    icon: payload.icon || "/site/icon-192.png",
    badge: payload.badge || "/site/favicon-32.png",
  });
}

/** إرسال إشعار Web Push واحد. لا يرمي استثناءً — يعيد نتيجة مفصّلة دائماً. */
export async function sendPushNotification(
  sub: StoredPushSubscription,
  payload: PushNotificationPayload,
  vapid: VapidKeys,
): Promise<PushSendResult> {
  const label = endpointLabel(sub.endpoint);
  let body: Uint8Array;
  let authorization: string;

  try {
    if (!sub.endpoint || !/^https:\/\//i.test(sub.endpoint)) {
      return { outcome: "error", status: null, error: "invalid endpoint" };
    }
    body = await encryptPayload(
      sub.p256dh,
      sub.auth,
      new TextEncoder().encode(buildPushBody(payload)),
    );
    authorization = await vapidAuthorization(sub.endpoint, vapid);
  } catch (err) {
    const message = err instanceof Error ? err.message : "encryption failed";
    console.error(`[Push] encrypt/sign failed for ${label}: ${message}`);
    return { outcome: "error", status: null, error: message };
  }

  try {
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(60 * 60 * 24),
        Urgency: "high",
      },
      body: body as unknown as BodyInit,
    });

    if (res.status === 201 || res.status === 202 || res.ok) {
      console.log(`[Push] ${label} -> ${res.status}`);
      return { outcome: "ok", status: res.status };
    }

    const text = (await res.text().catch(() => "")).slice(0, 300);
    console.error(`[Push] ${label} -> ${res.status} ${text}`);

    if (res.status === 404 || res.status === 410) {
      return { outcome: "gone", status: res.status, error: text || "subscription expired" };
    }
    return { outcome: "error", status: res.status, error: text || `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    console.error(`[Push] network failure for ${label}: ${message}`);
    return { outcome: "error", status: null, error: message };
  }
}
