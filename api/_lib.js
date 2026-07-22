import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const appJwtSecret = process.env.APP_SESSION_JWT_SECRET || process.env.APP_JWT_SECRET;
const downloadJwtSecret = process.env.DOWNLOAD_JWT_SECRET || appJwtSecret;
const adminJwtSecret = process.env.ADMIN_JWT_SECRET || appJwtSecret;
const JWT_ISSUER = 'aiway';
const APP_TOKEN_AUDIENCE = 'aiway-api';
const ADMIN_TOKEN_AUDIENCE = 'aiway-admin';
const DOWNLOAD_TOKEN_AUDIENCE = 'aiway-download';
const APP_SESSION_TTL = '12h';
const SESSION_COOKIE = 'aiway_session';

export function requireEnv() {
  const missing = [];
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!appJwtSecret || appJwtSecret.length < 32) missing.push('APP_SESSION_JWT_SECRET or APP_JWT_SECRET');
  if (missing.length) throw appError('MISSING_CONFIGURATION', { missing });
}

export function db() {
  requireEnv();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}


function escapeTelegramHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatCairoDateTime(value = new Date()) {
  try {
    return new Intl.DateTimeFormat('ar-EG-u-nu-latn', {
      timeZone: 'Africa/Cairo', dateStyle: 'medium', timeStyle: 'medium'
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
}

export async function sendTelegramNotification(html) {
  const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!botToken || !chatId) return { sent: false, skipped: true };
  try {
    const response = await fetchWithTimeout(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: String(html || '').slice(0, 3900),
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      },
      10000
    );
    if (!response.ok) {
      const payload = await response.text().catch(() => '');
      console.error('[TELEGRAM_NOTIFICATION_FAILED]', response.status, payload.slice(0, 500));
      return { sent: false, status: response.status };
    }
    return { sent: true };
  } catch (error) {
    console.error('[TELEGRAM_NOTIFICATION_FAILED]', error?.message || error);
    return { sent: false };
  }
}

export function telegramHtml(value) {
  return escapeTelegramHtml(value);
}

export function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify(body));
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const timeout = Math.max(1, Number(timeoutMs) || 15000);
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new DOMException('Request timed out', 'TimeoutError')), timeout);
  const callerSignal = options?.signal;
  const signal = callerSignal
    ? (typeof AbortSignal.any === 'function'
        ? AbortSignal.any([callerSignal, timeoutController.signal])
        : timeoutController.signal)
    : timeoutController.signal;

  let abortFromCaller;
  if (callerSignal && typeof AbortSignal.any !== 'function') {
    abortFromCaller = () => timeoutController.abort(callerSignal.reason);
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal });
  } finally {
    clearTimeout(timer);
    if (callerSignal && abortFromCaller) callerSignal.removeEventListener('abort', abortFromCaller);
  }
}

export function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) return true;
  res.setHeader('Allow', methods.join(', '));
  const locale = requestLocale(req);
  json(res, 405, {
    error: localize(locale, 'طريقة الطلب غير مسموح بها.', 'This request method is not allowed.'),
    code: 'METHOD_NOT_ALLOWED'
  });
  return false;
}


function cookieValue(req, name) {
  const raw = String(req?.headers?.cookie || '');
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV !== 'development';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(String(token || ''))}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=43200'
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV !== 'development';
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function enforceSameOrigin(req) {
  if (!['POST','PUT','PATCH','DELETE'].includes(String(req?.method || '').toUpperCase())) return;
  const site = String(req?.headers?.['sec-fetch-site'] || '').toLowerCase();
  if (site && !['same-origin','same-site','none'].includes(site)) throw appError('FORBIDDEN');
  const origin = String(req?.headers?.origin || '').trim();
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  if (origin && host) {
    let originHost = '';
    try { originHost = new URL(origin).host; } catch { throw appError('FORBIDDEN'); }
    if (originHost !== host) throw appError('FORBIDDEN');
  }
}

export async function signAppToken(user) {
  requireEnv();
  return new SignJWT({ username: user.username, pi_uid: user.pi_uid, role: user.role })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(APP_TOKEN_AUDIENCE)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(APP_SESSION_TTL)
    .sign(new TextEncoder().encode(appJwtSecret));
}

export async function createDownloadTicket(payload, expiresIn = '2m') {
  requireEnv();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(DOWNLOAD_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(downloadJwtSecret));
}

export async function verifyDownloadTicket(token) {
  requireEnv();
  if (!token) throw appError('UNAUTHORIZED');
  try {
    const { payload } = await jwtVerify(String(token), new TextEncoder().encode(downloadJwtSecret), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: DOWNLOAD_TOKEN_AUDIENCE
    });
    if (!payload.sub || !payload.kind || (!payload.messageId && !payload.imageId)) throw appError('UNAUTHORIZED');
    return payload;
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED') throw error;
    throw appError('UNAUTHORIZED', {}, error);
  }
}

export async function requireUser(req) {
  requireEnv();
  const authorization = req.headers.authorization || '';
  const headerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const cookieToken = cookieValue(req, SESSION_COOKIE);
  // Native browser downloads cannot attach an Authorization header. For the two
  // attachment-only POST routes, the signed app token is sent in the HTTPS form body.
  const bodyToken = req.method === 'POST' && String(req.body?.action || '').startsWith('download-')
    ? String(req.body?.authToken || '')
    : '';
  const token = cookieToken || headerToken || bodyToken;
  if (cookieToken) enforceSameOrigin(req);
  if (!token) throw appError('UNAUTHORIZED');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(appJwtSecret), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: APP_TOKEN_AUDIENCE
    });
    if (!payload.sub) throw appError('UNAUTHORIZED');

    // Never trust authorization-relevant claims from a stale token. Confirm that the
    // account still exists and read the current role from the database on every request.
    const supabase = db();
    const { data: currentUser, error } = await supabase
      .from('users')
      .select('id,username,pi_uid,role')
      .eq('id', payload.sub)
      .maybeSingle();
    if (error || !currentUser) throw appError('UNAUTHORIZED');

    // Paid balances are monthly. Expire any unused balance before every
    // authenticated API action so an expired package cannot be consumed.
    const { error: expiryError } = await supabase.rpc('expire_user_tokens', { p_user_id: currentUser.id });
    if (expiryError) throw appError('DATABASE_ERROR', {}, expiryError);
    return currentUser;
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED') throw error;
    throw appError('UNAUTHORIZED', {}, error);
  }
}

export async function requireAdmin(user) {
  if (!user?.id) throw appError('FORBIDDEN');
  const { data, error } = await db().from('users').select('role').eq('id', user.id).single();
  if (error || data?.role !== 'admin') throw appError('FORBIDDEN');
}


export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [type, salt, hash] = String(stored || '').split(':');
    if (type !== 'scrypt' || !salt || !hash) return false;
    const actual = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch { return false; }
}

export async function signAdminToken(admin) {
  requireEnv();
  return new SignJWT({ role: 'admin', email: admin.email, admin: true })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(JWT_ISSUER)
    .setAudience(ADMIN_TOKEN_AUDIENCE)
    .setSubject(admin.id).setIssuedAt().setExpirationTime('12h')
    .sign(new TextEncoder().encode(adminJwtSecret));
}

export async function requireAdminToken(req) {
  requireEnv();
  const authorization = req.headers.authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!token) throw appError('UNAUTHORIZED');
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(adminJwtSecret), {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: ADMIN_TOKEN_AUDIENCE
    });
    if (!payload.sub || payload.role !== 'admin' || !payload.admin) throw appError('FORBIDDEN');
    const { data: admin, error } = await db().from('admin_accounts').select('id,email,is_active').eq('id', payload.sub).maybeSingle();
    if (error || !admin?.is_active) throw appError('FORBIDDEN');
    return { ...payload, email: admin.email };
  } catch (error) {
    if (error?.code === 'FORBIDDEN') throw error;
    throw appError('UNAUTHORIZED', {}, error);
  }
}

export function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

export function requestLocale(req) {
  const value = req?.body?.locale || req?.query?.locale || req?.headers?.['x-ui-language'] || req?.headers?.['accept-language'] || 'ar';
  return String(value).toLowerCase().startsWith('en') ? 'en' : 'ar';
}

export function localize(locale, ar, en) {
  return String(locale).toLowerCase().startsWith('en') ? en : ar;
}

export function appError(code, meta = {}, cause = null) {
  const error = new Error(String(code || 'SERVER_ERROR'));
  error.code = String(code || 'SERVER_ERROR');
  error.meta = meta && typeof meta === 'object' ? meta : {};
  if (cause) error.cause = cause;
  return error;
}

function safeInteger(value) {
  const number = Math.max(0, Math.ceil(Number(value) || 0));
  return Number.isFinite(number) ? number : 0;
}

function formatTokens(value, language) {
  return safeInteger(value).toLocaleString('en-US');
}

function normalizedErrorCode(error) {
  const raw = String(error?.code || error?.message || error || '').trim();
  if (raw.startsWith('MODEL_ROUTE_MISMATCH:')) return 'MODEL_ROUTE_MISMATCH';
  if (/missing environment variables/i.test(raw)) return 'MISSING_CONFIGURATION';
  if (/aborterror|aborted|timed?\s*out|timeout/i.test(`${error?.name || ''} ${raw}`)) return 'REQUEST_TIMEOUT';
  if (/fetch failed|networkerror|econnreset|econnrefused|enotfound|socket hang up/i.test(raw)) return 'NETWORK_ERROR';
  if (/pgrst|postgres|supabase|relation .* does not exist|database/i.test(raw)) return 'DATABASE_ERROR';
  return raw;
}

export function errorDetails(error, locale = 'ar') {
  const language = String(locale).toLowerCase().startsWith('en') ? 'en' : 'ar';
  const code = normalizedErrorCode(error);
  const meta = error?.meta && typeof error.meta === 'object' ? error.meta : {};
  const available = safeInteger(meta.availableTokens);
  const required = safeInteger(meta.requiredTokens || meta.estimatedTokens);
  const shortfall = safeInteger(meta.shortfall || Math.max(0, required - available));

  const balanceFinished = {
    ar: 'رصيدك انتهى. اشحن رصيدًا جديدًا ثم أعد إرسال الرسالة.',
    en: 'Your balance has run out. Add more balance, then send the message again.'
  };
  const insufficientForRequest = {
    ar: `رصيدك الحالي ${formatTokens(available, language)} توكن، بينما التكلفة التقديرية لهذا الطلب نحو ${formatTokens(required, language)} توكن. اشحن ${formatTokens(shortfall, language)} توكن إضافي على الأقل ثم حاول مرة أخرى.`,
    en: `Your current balance is ${formatTokens(available, language)} tokens, while this request is estimated to need about ${formatTokens(required, language)} tokens. Add at least ${formatTokens(shortfall, language)} more tokens and try again.`
  };

  const messages = {
    METHOD_NOT_ALLOWED: [405, { ar: 'طريقة الطلب غير مسموح بها.', en: 'This request method is not allowed.' }],
    INVALID_REQUEST: [400, { ar: 'بيانات الطلب غير مكتملة أو غير صحيحة. راجع المدخلات وحاول مرة أخرى.', en: 'The request data is incomplete or invalid. Check the inputs and try again.' }],
    INVALID_CHAT_REQUEST: [400, { ar: 'تعذر إرسال الرسالة لأن بيانات المحادثة غير مكتملة. حدّث الصفحة وحاول مرة أخرى.', en: 'The message could not be sent because the chat data is incomplete. Refresh the page and try again.' }],
    INVALID_IMAGE_REQUEST: [400, { ar: 'بيانات طلب الصورة غير مكتملة. اكتب وصفًا واضحًا ثم حاول مرة أخرى.', en: 'The image request is incomplete. Enter a clear description and try again.' }],
    UNAUTHORIZED: [401, { ar: 'انتهت جلسة تسجيل الدخول أو لم تبدأ بعد. سجّل الدخول بحساب Pi ثم حاول مرة أخرى.', en: 'Your sign-in session is missing or expired. Sign in with Pi and try again.' }],
    FORBIDDEN: [403, { ar: 'ليس لديك صلاحية لتنفيذ هذا الإجراء.', en: 'You do not have permission to perform this action.' }],
    INSUFFICIENT_TOKENS: [402, available <= 0 ? balanceFinished : {
      ar: 'رصيدك غير كافٍ لإتمام الطلب. اشحن رصيدًا إضافيًا ثم حاول مرة أخرى.',
      en: 'Your balance is insufficient to complete the request. Add more balance and try again.'
    }],
    INSUFFICIENT_TOKENS_FOR_REQUEST: [402, insufficientForRequest],
    LOW_BALANCE: [200, {
      ar: `رصيدك أوشك على النفاد: متبقٍ ${formatTokens(available, language)} توكن. اشحن رصيدًا لتجنب توقف الرسائل.`,
      en: `Your balance is running low: ${formatTokens(available, language)} tokens remain. Add balance to avoid interruptions.`
    }],
    PROVIDER_CREDITS_EXHAUSTED: [503, {
      ar: 'رصيد مزود الذكاء الاصطناعي انتهى مؤقتًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay لإعادة شحن الخدمة.',
      en: 'The AI provider balance is temporarily exhausted. Your balance was not charged; contact AiWay support so the service can be topped up.'
    }],
    OPENROUTER_CREDITS_EXHAUSTED: [503, {
      ar: 'رصيد مزود الذكاء الاصطناعي انتهى مؤقتًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay لإعادة شحن الخدمة.',
      en: 'The AI provider balance is temporarily exhausted. Your balance was not charged; contact AiWay support so the service can be topped up.'
    }],
    PROVIDER_AUTH_ERROR: [503, {
      ar: 'إعداد الاتصال بمزود الذكاء الاصطناعي غير صالح حاليًا. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The AI provider connection is not configured correctly right now. Your balance was not charged; contact AiWay support.'
    }],
    PROVIDER_PERMISSION_DENIED: [503, {
      ar: 'مزود الذكاء الاصطناعي رفض تشغيل هذه الخدمة بالحساب الحالي. لن يتم خصم رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The AI provider rejected this service for the current account. Your balance was not charged; contact AiWay support.'
    }],
    FREE_DAILY_LIMIT: [429, {
      ar: 'استخدمت 30 طلبًا مجانيًا اليوم. اختر نموذجًا آخر للمتابعة، وستتجدد الطلبات المجانية تلقائيًا غدًا.',
      en: 'You have used all 30 free requests for today. Choose another model to continue; your free requests reset automatically tomorrow.'
    }],
    RATE_LIMITED: [429, {
      ar: 'هناك ضغط مرتفع أو تم بلوغ حد الطلبات مؤقتًا. انتظر قليلًا ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'The service is busy or its request limit was reached temporarily. Wait a moment and try again; your balance was not charged.'
    }],
    REQUEST_TIMEOUT: [504, {
      ar: 'استغرق الطلب وقتًا أطول من المسموح. حاول مرة أخرى برسالة أقصر أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The request took too long. Try a shorter message or choose another model; your balance was not charged.'
    }],
    NETWORK_ERROR: [503, {
      ar: 'تعذر الاتصال بالخدمة. تحقق من الإنترنت ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'Could not connect to the service. Check your internet connection and try again; your balance was not charged.'
    }],
    MODEL_LOCKED: [403, {
      ar: 'هذا النموذج متاح بعد أول عملية شراء. استخدم نموذج التجربة المجانية أو اشحن رصيدًا لفتح جميع النماذج.',
      en: 'This model unlocks after your first purchase. Use the free-trial model or add balance to unlock all models.'
    }],
    MODEL_UNAVAILABLE: [503, {
      ar: 'النموذج المختار غير متاح حاليًا. حدّث قائمة النماذج واختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The selected model is currently unavailable. Refresh the model list and choose another model; your balance was not charged.'
    }],
    IMAGE_MODEL_UNAVAILABLE: [503, {
      ar: 'نموذج الصور المختار غير متاح حاليًا. حدّث قائمة النماذج واختر نموذج صور آخر؛ لم يتم خصم رصيدك.',
      en: 'The selected image model is currently unavailable. Refresh the model list and choose another image model; your balance was not charged.'
    }],
    NO_PROVIDER_AVAILABLE: [503, {
      ar: 'لا يوجد مزود متاح لهذا النموذج حاليًا. اختر نموذجًا آخر أو حاول بعد قليل؛ لم يتم خصم رصيدك.',
      en: 'No provider is currently available for this model. Choose another model or try again shortly; your balance was not charged.'
    }],
    PROVIDER_ERROR: [502, {
      ar: 'حدث عطل مؤقت لدى مزود الذكاء الاصطناعي. حاول مرة أخرى أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The AI provider had a temporary failure. Try again or choose another model; your balance was not charged.'
    }],
    STREAM_INTERRUPTED: [502, {
      ar: 'انقطع الاتصال أثناء كتابة الإجابة. أعد المحاولة؛ لن يُخصم رصيد عن الرد غير المكتمل.',
      en: 'The connection was interrupted while the answer was being written. Try again; an incomplete response will not be charged.'
    }],
    EMPTY_RESPONSE: [502, {
      ar: 'لم يُرجع النموذج إجابة صالحة. حاول مرة أخرى أو اختر نموذجًا آخر؛ لم يتم خصم رصيدك.',
      en: 'The model did not return a valid answer. Try again or choose another model; your balance was not charged.'
    }],
    CONTENT_BLOCKED: [400, {
      ar: 'رفض مزود الذكاء هذا الطلب بسبب سياسات المحتوى. عدّل صياغة الرسالة أو المرفق ثم حاول مرة أخرى؛ لم يتم خصم رصيدك.',
      en: 'The AI provider blocked this request under its content policies. Revise the message or attachment and try again; your balance was not charged.'
    }],
    CONTEXT_TOO_LONG: [413, {
      ar: 'المحادثة أو المرفقات أكبر من سعة النموذج. اختصر الرسالة، ابدأ محادثة جديدة، أو استخدم مرفقًا أصغر.',
      en: 'The conversation or attachments exceed the model capacity. Shorten the message, start a new chat, or use a smaller attachment.'
    }],
    ATTACHMENT_TOO_LARGE: [413, {
      ar: 'حجم المرفق أكبر من المسموح. قلّل الحجم أو أرسل عددًا أقل من الملفات ثم حاول مرة أخرى.',
      en: 'The attachment is larger than allowed. Reduce its size or send fewer files and try again.'
    }],
    INVALID_ATTACHMENT: [400, {
      ar: 'صيغة أحد المرفقات غير مدعومة أو بياناته غير صالحة. احذف المرفق وأعد رفعه بصيغة أخرى.',
      en: 'An attachment has an unsupported format or invalid data. Remove it and upload it again in another format.'
    }],
    REFERENCE_IMAGE_UNSUPPORTED: [400, {
      ar: 'النموذج المختار لا يدعم الصور المرجعية. اختر نموذج صور يدعم إدخال الصور.',
      en: 'The selected model does not support reference images. Choose an image model that accepts image input.'
    }],
    TRIAL_WEB_LOCKED: [403, { ar: 'بحث الويب متاح بعد أول عملية شراء.', en: 'Web search unlocks after your first purchase.' }],
    TRIAL_ENDED: [402, {
      ar: 'انتهت رسائلك التجريبية. اشحن رصيدًا لفتح جميع النماذج ومتابعة الاستخدام.',
      en: 'Your free-trial messages have ended. Add balance to unlock all models and continue.'
    }],
    MODEL_ROUTE_MISMATCH: [502, {
      ar: 'أعاد المزود نموذجًا مختلفًا عن النموذج المختار، لذلك أُوقف الطلب ولم يتم خصم رصيدك.',
      en: 'The provider returned a different model than the one selected, so the request was stopped and your balance was not charged.'
    }],
    FILE_NOT_FOUND: [404, { ar: 'الملف غير موجود أو لم يعد متاحًا.', en: 'The file was not found or is no longer available.' }],
    IMAGE_NOT_FOUND: [404, { ar: 'الصورة غير موجودة أو لم تعد متاحة.', en: 'The image was not found or is no longer available.' }],
    DATABASE_ERROR: [503, {
      ar: 'تعذر حفظ البيانات حاليًا. حاول مرة أخرى بعد قليل؛ لن يتم خصم رصيدك عن طلب لم يُحفظ.',
      en: 'The data could not be saved right now. Try again shortly; a request that was not saved will not be charged.'
    }],
    MISSING_CONFIGURATION: [503, {
      ar: 'إعدادات الخدمة على الخادم غير مكتملة. تواصل مع إدارة AiWay.',
      en: 'The server configuration is incomplete. Contact AiWay support.'
    }],
    OKX_PRICE_UNAVAILABLE: [503, {
      ar: 'تعذر جلب سعر Pi حاليًا. انتظر قليلًا ثم أعد فتح نافذة الشحن.',
      en: 'The Pi price is currently unavailable. Wait a moment, then reopen the top-up window.'
    }],
    PAYMENT_INVALID: [400, { ar: 'بيانات الدفعة أو الباقة غير صحيحة.', en: 'The payment or package details are invalid.' }],
    PAYMENT_PENDING: [409, {
      ar: 'الدفعة لم تصل إلى الشبكة بعد. أكملها من المحفظة ثم أعد إنهاء الدفعات المعلقة.',
      en: 'The payment has not reached the network yet. Complete it in your wallet, then finish pending payments again.'
    }],
    PI_LOGIN_FAILED: [401, {
      ar: 'تعذر التحقق من حساب Pi. افتح الموقع داخل Pi Browser وسجّل الدخول من جديد.',
      en: 'Could not verify your Pi account. Open the site in Pi Browser and sign in again.'
    }],
    PI_SERVICE_UNAVAILABLE: [503, {
      ar: 'خدمة Pi غير متاحة مؤقتًا. لم يتغير رصيدك؛ حاول مرة أخرى بعد قليل.',
      en: 'The Pi service is temporarily unavailable. Your balance was not changed; try again shortly.'
    }],
    PAYMENT_PROVIDER_AUTH_ERROR: [503, {
      ar: 'إعدادات الدفع عبر Pi على الخادم غير صالحة حاليًا. لم يتغير رصيدك؛ تواصل مع إدارة AiWay.',
      en: 'The server-side Pi payment settings are currently invalid. Your balance was not changed; contact AiWay support.'
    }],
    REQUEST_IN_PROGRESS: [409, { ar: 'يوجد طلب ذكاء قيد التنفيذ بالفعل. انتظر اكتماله ثم أرسل طلبًا جديدًا.', en: 'An AI request is already in progress. Let it finish before sending another.' }],
    REQUEST_ALREADY_PROCESSED: [409, { ar: 'تمت معالجة هذا الطلب من قبل. حدّث المحادثة لعرض النتيجة.', en: 'This request was already processed. Refresh the conversation to view the result.' }],
    PAYMENT_MISMATCH: [400, { ar: 'بيانات عملية الدفع لا تطابق الباقة أو الحساب الحالي، لذلك لم تتم إضافة الرصيد.', en: 'The payment does not match the selected package or current account, so no balance was added.' }],
    PAYMENT_FAILED: [502, {
      ar: 'تعذر إتمام الدفع عبر Pi حاليًا. لم تتم إضافة أو خصم رصيد؛ حاول مرة أخرى.',
      en: 'The Pi payment could not be completed right now. No balance was added or deducted; try again.'
    }]
  };

  const entry = messages[code];
  if (!entry) return null;
  return {
    status: entry[0],
    message: entry[1][language],
    code,
    meta: {
      ...(required ? { requiredTokens: required } : {}),
      ...(available || code === 'INSUFFICIENT_TOKENS' || code === 'INSUFFICIENT_TOKENS_FOR_REQUEST' ? { availableTokens: available } : {}),
      ...(shortfall ? { shortfall } : {})
    }
  };
}

function providerPayloadText(payload) {
  if (typeof payload === 'string') return payload.slice(0, 1000);
  return String(payload?.error?.message || payload?.message || payload?.error_description || payload?.error || '').slice(0, 1000);
}

export function openRouterError(status, payload, options = {}) {
  const message = providerPayloadText(payload);
  const lower = message.toLowerCase();
  const kind = options.kind === 'image' ? 'image' : 'chat';
  let code = 'PROVIDER_ERROR';

  if (status === 401) code = 'PROVIDER_AUTH_ERROR';
  else if (status === 402 || /insufficient credits|credit balance|add more credits|payment required/.test(lower)) code = 'PROVIDER_CREDITS_EXHAUSTED';
  else if (status === 403 && /moderation|policy|content|guardrail|safety|flagged|blocked/.test(lower)) code = 'CONTENT_BLOCKED';
  else if (status === 403) code = 'PROVIDER_PERMISSION_DENIED';
  else if (status === 404) code = kind === 'image' ? 'IMAGE_MODEL_UNAVAILABLE' : 'MODEL_UNAVAILABLE';
  else if (status === 408 || status === 504 || /timed? out|timeout/.test(lower)) code = 'REQUEST_TIMEOUT';
  else if (status === 413 || /payload too large|file too large|attachment too large/.test(lower)) code = 'ATTACHMENT_TOO_LARGE';
  else if (status === 429 || /rate limit|too many requests|requests per minute|requests per day/.test(lower)) code = 'RATE_LIMITED';
  else if (/context length|maximum context|too many tokens|prompt is too long|token limit/.test(lower)) code = 'CONTEXT_TOO_LONG';
  else if (/moderation|content policy|safety|guardrail|flagged|blocked/.test(lower)) code = 'CONTENT_BLOCKED';
  else if (/model .*not found|unknown model|model unavailable|model is unavailable|model.*down/.test(lower)) code = kind === 'image' ? 'IMAGE_MODEL_UNAVAILABLE' : 'MODEL_UNAVAILABLE';
  else if (status === 503 || /no providers available|no available providers|provider unavailable/.test(lower)) code = 'NO_PROVIDER_AVAILABLE';
  else if (status === 400) code = 'INVALID_REQUEST';
  else if (status >= 500) code = 'PROVIDER_ERROR';

  return appError(code, { providerStatus: Number(status) || 0, kind, internalMessage: message });
}

export function piApiError(status, payload, options = {}) {
  const message = providerPayloadText(payload).toLowerCase();
  const operation = options.operation === 'login' ? 'login' : 'payment';
  let code = operation === 'login' ? 'PI_LOGIN_FAILED' : 'PAYMENT_FAILED';
  if (status === 401 || status === 403) code = operation === 'login' ? 'UNAUTHORIZED' : 'PAYMENT_PROVIDER_AUTH_ERROR';
  else if (status === 404) code = operation === 'login' ? 'PI_LOGIN_FAILED' : 'PAYMENT_INVALID';
  else if (status === 408 || status === 504 || /timed? out|timeout/.test(message)) code = 'REQUEST_TIMEOUT';
  else if (operation === 'payment' && (status === 409 || /pending|not completed|not approved|transaction.*missing/.test(message))) code = 'PAYMENT_PENDING';
  else if (status === 429 || /rate limit|too many requests/.test(message)) code = 'RATE_LIMITED';
  else if (status >= 500) code = 'PI_SERVICE_UNAVAILABLE';
  return appError(code, { providerStatus: Number(status) || 0, internalMessage: providerPayloadText(payload) });
}

export function shouldTryModelFallback(error) {
  const code = normalizedErrorCode(error);
  return ['MODEL_UNAVAILABLE', 'NO_PROVIDER_AVAILABLE', 'PROVIDER_ERROR', 'REQUEST_TIMEOUT'].includes(code);
}

export function handleError(error, res, fallback = 'Server error', locale = 'ar') {
  const details = errorDetails(error, locale);
  if (details) {
    const internal = error?.cause?.message || error?.meta?.internalMessage || '';
    console.warn(`[${details.code}]${internal ? ` ${internal}` : ''}`);
    return json(res, details.status, { error: details.message, code: details.code, ...details.meta });
  }
  console.error(error);
  return json(res, 500, { error: fallback, code: 'SERVER_ERROR' });
}

// Each AiWay Token represents $0.00001 of provider capacity.
// Customers receive provider capacity equal to 50% of what they pay:
// $1 => $0.50 capacity => 50,000 AiWay Tokens.
export const TOKEN_USD = 0.00001;
export const MARKUP = 2;
export const TRIAL_MESSAGE_LIMIT = 5;
export const TRIAL_TOKENS = 1500;
export const TRIAL_MODEL_FALLBACK = 'google/gemma-4-26b-a4b-it:free';
const tokensForUsd = usd => Math.round((Number(usd) * 0.5) / TOKEN_USD);
export const PACKAGES = {
  starter: { usd: 1, tokens: tokensForUsd(1) },
  plus: { usd: 5, tokens: tokensForUsd(5) },
  pro: { usd: 10, tokens: tokensForUsd(10) }
};

const FAMILY_CONFIG = [
  { key: 'chatgpt', label: 'ChatGPT', prefix: 'openai/', tag: 'OpenAI' },
  { key: 'gemini', label: 'Gemini', prefix: 'google/', tag: 'Google' },
  { key: 'deepseek', label: 'DeepSeek', prefix: 'deepseek/', tag: 'DeepSeek' },
  { key: 'claude', label: 'Claude', prefix: 'anthropic/', tag: 'Anthropic' },
  { key: 'grok', label: 'Grok', prefix: 'x-ai/', tag: 'xAI' },
  { key: 'kimi', label: 'Kimi', prefix: 'moonshotai/', tag: 'Moonshot AI' }
];

const FALLBACK_MODELS = [
  { id: 'openai/gpt-4o', name: 'GPT-4o', created: 1715558400, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.0000025, completion: 0.00001 } },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o mini', created: 1721174400, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.00000015, completion: 0.0000006 } },
  { id: 'openai/o3-mini', name: 'o3-mini', created: 1738281600, family: 'chatgpt', tag: 'OpenAI', pricing: { prompt: 0.0000011, completion: 0.0000044 } },
  { id: 'google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash', created: 1738540800, family: 'gemini', tag: 'Google', pricing: { prompt: 0.0000001, completion: 0.0000004 } },
  { id: 'google/gemini-2.5-pro-preview', name: 'Gemini 2.5 Pro', created: 1743379200, family: 'gemini', tag: 'Google', pricing: { prompt: 0.00000125, completion: 0.00001 } },
  { id: 'google/gemini-2.5-flash-preview', name: 'Gemini 2.5 Flash', created: 1743379201, family: 'gemini', tag: 'Google', pricing: { prompt: 0.0000003, completion: 0.0000025 } },
  { id: TRIAL_MODEL_FALLBACK, name: 'Gemma 4 26B A4B (free)', created: 1780000000, family: 'gemini', tag: 'Google', pricing: { prompt: 0, completion: 0 } },
  { id: 'deepseek/deepseek-r1', name: 'DeepSeek R1', created: 1738281600, family: 'deepseek', tag: 'DeepSeek', pricing: { prompt: 0.00000055, completion: 0.00000219 } },
  { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', created: 1733011200, family: 'deepseek', tag: 'DeepSeek', pricing: { prompt: 0.00000027, completion: 0.0000011 } },
  { id: 'anthropic/claude-3.7-sonnet', name: 'Claude 3.7 Sonnet', created: 1740355200, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', created: 1718841600, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku', created: 1729555200, family: 'claude', tag: 'Anthropic', pricing: { prompt: 0.0000008, completion: 0.000004 } },
  { id: 'x-ai/grok-4', name: 'Grok 4', created: 1752105600, family: 'grok', tag: 'xAI', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'x-ai/grok-3', name: 'Grok 3', created: 1746057600, family: 'grok', tag: 'xAI', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'x-ai/grok-3-mini', name: 'Grok 3 Mini', created: 1746057500, family: 'grok', tag: 'xAI', pricing: { prompt: 0.0000003, completion: 0.0000005 } },
  { id: 'x-ai/grok-3-beta', name: 'Grok 3 Beta', created: 1743465600, family: 'grok', tag: 'xAI', pricing: { prompt: 0.000003, completion: 0.000015 } },
  { id: 'x-ai/grok-3-mini-beta', name: 'Grok 3 Mini Beta', created: 1743465500, family: 'grok', tag: 'xAI', pricing: { prompt: 0.0000003, completion: 0.0000005 } },
  { id: 'moonshotai/kimi-k2-0905', name: 'Kimi K2 0905', created: 1757030400, family: 'kimi', tag: 'Moonshot AI', pricing: { prompt: 0.0000006, completion: 0.0000025 } },
  { id: 'moonshotai/kimi-k2', name: 'Kimi K2', created: 1752192000, family: 'kimi', tag: 'Moonshot AI', pricing: { prompt: 0.0000006, completion: 0.0000025 } },
  { id: 'moonshotai/kimi-dev-72b', name: 'Kimi Dev 72B', created: 1748736000, family: 'kimi', tag: 'Moonshot AI', pricing: { prompt: 0.0000003, completion: 0.0000012 } },
  { id: 'moonshotai/moonlight-16b-a3b-instruct', name: 'Moonlight 16B A3B Instruct', created: 1740873600, family: 'kimi', tag: 'Moonshot AI', pricing: { prompt: 0.0000002, completion: 0.0000008 } },
  { id: 'moonshotai/kimi-vl-a3b-thinking', name: 'Kimi VL A3B Thinking', created: 1746057400, family: 'kimi', tag: 'Moonshot AI', pricing: { prompt: 0.0000004, completion: 0.0000016 } }
];

let catalogCache = { at: 0, models: FALLBACK_MODELS };

function isTextChatModel(model) {
  const id = String(model.id || '').toLowerCase();
  if (!id || id.includes('embedding') || id.includes('moderation') || id.includes('image') || id.includes('audio') || id.includes('tts')) return false;
  const outputs = model.architecture?.output_modalities;
  if (Array.isArray(outputs) && !outputs.includes('text')) return false;
  return true;
}

function normalizeModel(model, family) {
  const promptPrice = Number(model.pricing?.prompt || 0);
  const completionPrice = Number(model.pricing?.completion || 0);
  return {
    id: model.id,
    name: model.name || model.id.split('/').pop(),
    description: model.description || '',
    created: Number(model.created || 0),
    contextLength: Number(model.context_length || 0),
    family: family.key,
    familyLabel: family.label,
    tag: family.tag,
    isFree: promptPrice === 0 && completionPrice === 0,
    pricing: {
      prompt: promptPrice,
      completion: completionPrice,
      webSearch: Number(model.pricing?.web_search || 0)
    }
  };
}

export async function getAvailableModels() {
  if (Date.now() - catalogCache.at < 60 * 60 * 1000 && catalogCache.models.length >= 20) return catalogCache.models;
  try {
    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/models', {
      headers: process.env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}
    }, 15000);
    if (!response.ok) throw new Error(`OpenRouter models ${response.status}`);
    const payload = await response.json();
    const selected = [];
    for (const family of FAMILY_CONFIG) {
      const familyModels = (payload.data || [])
        .filter(model => {
          if (!String(model.id || '').startsWith(family.prefix) || !isTextChatModel(model)) return false;
          const promptPrice = Number(model.pricing?.prompt || 0);
          const completionPrice = Number(model.pricing?.completion || 0);
          const isZeroCost = promptPrice === 0 && completionPrice === 0;
          return model.id === TRIAL_MODEL_FALLBACK || !isZeroCost;
        })
        .map(model => normalizeModel(model, family))
        .sort((a, b) => b.created - a.created || a.name.localeCompare(b.name))
        .slice(0, 5);
      selected.push(...familyModels);
    }
    if (selected.length < FAMILY_CONFIG.length * 5) throw new Error('Incomplete OpenRouter catalog');
    const trialFromPayload = (payload.data || []).find(model => model.id === TRIAL_MODEL_FALLBACK);
    const trialModel = trialFromPayload
      ? normalizeModel(trialFromPayload, FAMILY_CONFIG.find(family => family.key === 'gemini'))
      : FALLBACK_MODELS.find(model => model.id === TRIAL_MODEL_FALLBACK);
    if (trialModel && !selected.some(model => model.id === TRIAL_MODEL_FALLBACK)) {
      const googleIndex = selected.findIndex(model => model.family === 'gemini');
      selected.splice(googleIndex >= 0 ? googleIndex : 0, 0, trialModel);
    }
    // Only the official Gemma trial model is exposed as free.
    catalogCache = { at: Date.now(), models: selected };
    return selected;
  } catch (error) {
    console.warn('Using fallback model catalog:', error.message);
    return catalogCache.models;
  }
}

export function isFreeModel(model) {
  return Boolean(model && Number(model?.pricing?.prompt) === 0 && Number(model?.pricing?.completion) === 0);
}

export async function chooseAutoModel(text = '', { webSearch = false, hasAttachments = false } = {}) {
  const models = await getAvailableModels();
  const available = models.filter(m => isTextChatModel(m));
  const free = available.filter(isFreeModel);
  const q = String(text || '').toLowerCase();
  const complex = q.length > 1400 || /(?:حلل|تحليل عميق|برمجة|كود|debug|architecture|security|رياضيات|reason|research|compare)/i.test(q);
  const coding = /(?:كود|برمجة|خطأ|بايثون|جافاسكربت|sql|code|debug|function|api)/i.test(q);
  let pool = free.length ? free : available;
  if (webSearch || hasAttachments || complex) {
    const capable = available.filter(m => Number(m.contextLength || 0) >= 64000);
    if (capable.length) pool = capable;
  }
  const score = m => {
    const p = Number(m.pricing?.prompt || 0), c = Number(m.pricing?.completion || 0);
    let value = (p + c * 2) * 1e6;
    if (isFreeModel(m)) value -= 1000;
    if (coding && /qwen|deepseek|coder|gemma/i.test(`${m.id} ${m.name}`)) value -= 50;
    if (complex && /reason|r1|pro|large|70b|31b|27b/i.test(`${m.id} ${m.name}`)) value -= 20;
    return value;
  };
  return [...pool].sort((a,b)=>score(a)-score(b))[0] || available[0] || null;
}

export async function claimFreeDailyUse(supabase, userId, kind = 'chat') {
  const limit = 30;
  const { data, error } = await supabase.rpc('claim_free_model_request', { p_user_id:userId, p_kind:kind, p_daily_limit:limit });
  if (error) {
    if (String(error.message || '').toLowerCase().includes('daily free limit')) throw appError('FREE_DAILY_LIMIT', { freeDailyLimit: limit, freeRequestKind: kind });
    throw appError('DATABASE_ERROR', {}, error);
  }
  return data || {};
}

export async function getTrialModelId() {
  // Keep the free trial pinned to one exact OpenRouter model.
  return TRIAL_MODEL_FALLBACK;
}

export async function getModel(modelId) {
  return (await getAvailableModels()).find(model => model.id === modelId) || null;
}

export function chargeTokens(price, usage = {}, webSearch = false) {
  const input = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const output = Number(usage.completion_tokens || usage.output_tokens || 0);
  const reportedCost = Number(usage.cost || 0);
  const webSearchFallbackUsd = webSearch ? Number(price?.webSearch || 0.01) : 0;
  const fallbackCost = input * Number(price?.prompt || 0) + output * Number(price?.completion || 0) + webSearchFallbackUsd;
  const hasReportedCost = Number.isFinite(reportedCost) && reportedCost > 0;
  const providerUsd = hasReportedCost ? reportedCost : fallbackCost;
  return {
    input,
    output,
    providerUsd,
    costSource: hasReportedCost ? 'openrouter_usage' : 'catalog_estimate',
    tokenUsd: TOKEN_USD,
    markup: MARKUP,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD))
  };
}


function estimateTextTokens(value = '') {
  const text = String(value || '').trim();
  if (!text) return 0;
  const arabic = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z0-9]+(?:['_-][A-Za-z0-9]+)*/g) || []).length;
  const arabicWords = (text.match(/[\u0600-\u06FF]+/g) || []).length;
  const punctuation = (text.match(/[^\s\p{L}\p{N}]/gu) || []).length;
  const codeLines = (text.match(/```|[{}[\]();<>_=+*/\\|`~]|\b(?:const|let|var|function|class|import|export|SELECT|FROM|WHERE)\b/g) || []).length;
  const urls = (text.match(/https?:\/\/\S+/g) || []).reduce((sum, url) => sum + Math.ceil(url.length / 3), 0);
  const wordEstimate = arabicWords * 1.35 + latinWords * 1.12;
  const characterFloor = text.length / (arabic > text.length * 0.2 ? 2.55 : 3.85);
  return Math.max(1, Math.ceil(Math.max(wordEstimate, characterFloor) + punctuation * 0.18 + codeLines * 0.42 + urls));
}

function attachmentTokenEstimate(attachment = {}) {
  const type = String(attachment.type || attachment.mime_type || '').toLowerCase();
  const size = Math.max(0, Number(attachment.size || attachment.size_bytes || 0));
  if (type.startsWith('image/')) {
    // OpenRouter ultimately reports native multimodal token usage. Before sending,
    // dimensions are not always available, so use a conservative size-based band.
    if (!size) return 1050;
    if (size <= 350_000) return 750;
    if (size <= 1_500_000) return 1250;
    if (size <= 4_000_000) return 1900;
    return 2600;
  }
  if (type.includes('pdf')) return Math.max(900, Math.min(16000, Math.ceil(size / 155)));
  if (type.startsWith('text/') || /json|xml|javascript|typescript|csv|markdown/.test(type)) return Math.max(220, Math.min(14000, Math.ceil(size / 3.2)));
  return Math.max(500, Math.min(9000, Math.ceil(size / 230)));
}

function estimatedContentTokens(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:')) return 0;
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimatedContentTokens(item), 0);
  if (!value || typeof value !== 'object') return 0;
  if (value.type === 'image_url') return 1050;
  if (value.type === 'file') return 1500;
  if (value.name || value.mime_type || value.size || value.size_bytes) return attachmentTokenEstimate(value);
  return Object.entries(value).reduce((sum, [key, item]) => {
    if (key === 'file_data' || key === 'url' || key === 'dataUrl') return sum;
    return sum + estimatedContentTokens(item);
  }, 0);
}

function latestUserText(messages = []) {
  const latest = [...messages].reverse().find(message => message?.role === 'user');
  return typeof latest?.content === 'string' ? latest.content : '';
}

function expectedOutputTokens(text, inputTokens, attachmentCount, imageCount, webSearch) {
  const value = String(text || '');
  const latestTokens = Math.max(1, estimateTextTokens(value));
  const asksForCode = /```|\b(code|كود|برمج|برنامج|function|api|html|javascript|python|sql)\b/i.test(value);
  const asksForLong = /\b(explain|detailed|complete|full|report|article|essay|حلل|اشرح|بالتفصيل|كامل|تقرير|مقال)\b/i.test(value);
  const asksForShort = /\b(short|brief|one word|مختصر|باختصار|كلمة واحدة)\b/i.test(value);
  let ratio = asksForCode ? 2.25 : asksForLong ? 1.75 : asksForShort ? 0.55 : 1.15;
  let predicted = 150 + latestTokens * ratio + Math.sqrt(Math.max(1, inputTokens)) * 14;
  predicted += attachmentCount * 110 + imageCount * 170 + (webSearch ? 360 : 0);
  return Math.max(96, Math.min(8192, Math.ceil(predicted)));
}

export function estimateChatCharge(price, messages = [], webSearch = false, outputReserve = 0) {
  const safeMessages = Array.isArray(messages) ? messages : [];
  // Message framing differs by native tokenizer; 14 tokens/message plus a small
  // conversation header is a closer preflight approximation than word count alone.
  const inputTokens = Math.max(1, estimatedContentTokens(safeMessages) + 14 * safeMessages.length + 8);
  const attachmentCount = safeMessages.reduce((sum, message) => sum + (Array.isArray(message?.attachments) ? message.attachments.length : 0), 0);
  const imageCount = safeMessages.reduce((sum, message) => sum + (Array.isArray(message?.attachments) ? message.attachments.filter(item => String(item?.type || '').startsWith('image/')).length : 0), 0);
  const automaticOutput = expectedOutputTokens(latestUserText(safeMessages), inputTokens, attachmentCount, imageCount, webSearch);
  const requestedReserve = Number(outputReserve || 0);
  const reservedOutputTokens = Math.max(96, Math.min(8192, Math.ceil(requestedReserve > 0 ? Math.max(requestedReserve, automaticOutput) : automaticOutput)));
  const promptRate = Math.max(0, Number(price?.prompt || 0));
  const completionRate = Math.max(0, Number(price?.completion || 0));
  const requestUsd = Math.max(0, Number(price?.request || 0));
  const inputUsd = inputTokens * promptRate;
  const outputUsd = reservedOutputTokens * completionRate;
  // Current OpenRouter web-plugin pricing is normally $0.005/request; use a
  // model-catalog value when supplied and otherwise this documented baseline.
  const webUsd = webSearch ? Math.max(0, Number(price?.web_search ?? price?.webSearch ?? 0.005)) : 0;
  const providerUsd = inputUsd + outputUsd + requestUsd + webUsd;
  return {
    inputTokens,
    reservedOutputTokens,
    attachmentCount,
    imageCount,
    webSearch: Boolean(webSearch),
    inputUsd,
    outputUsd,
    requestUsd,
    webUsd,
    providerUsd,
    chargedTokens: Math.max(1, Math.ceil(providerUsd / TOKEN_USD))
  };
}

export function affordableOutputLimit(price, availableTokens, estimate, cap = 8192) {
  const completionPrice = Number(price?.completion || 0);
  if (!(completionPrice > 0)) return Math.max(128, cap);
  const availableUsd = Math.max(0, Number(availableTokens || 0) * TOKEN_USD * 0.9);
  const fixedUsd = Math.max(0, Number(estimate?.inputUsd || 0) + Number(estimate?.webUsd || 0));
  const affordable = Math.floor((availableUsd - fixedUsd) / completionPrice);
  return Math.max(0, Math.min(cap, affordable));
}

export function isLowBalance(remainingTokens, lastCharge = 0) {
  const remaining = Math.max(0, Number(remainingTokens || 0));
  return remaining > 0 && remaining < Math.max(1000, Math.ceil(Number(lastCharge || 0) * 2));
}


export async function classifyTokenChargeFailure(supabase, userId, requiredTokens, cause = null) {
  const required = Math.max(1, Math.ceil(Number(requiredTokens) || 1));
  const { data: profile, error } = await supabase.from('users')
    .select('ai_tokens,trial_messages_remaining,has_purchased')
    .eq('id', userId)
    .single();
  if (error || !profile) return appError('DATABASE_ERROR', {}, error || cause);
  const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
  if (!profile.has_purchased && Number(profile.trial_messages_remaining || 0) <= 0) {
    return appError('TRIAL_ENDED', { availableTokens }, cause);
  }
  if (availableTokens < required) {
    return appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
      availableTokens,
      requiredTokens: required,
      shortfall: required - availableTokens
    }, cause);
  }
  return appError('DATABASE_ERROR', {}, cause);
}

export async function getPiUsd() {
  const response = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=PI-USDT', { headers: { 'User-Agent': 'AiWay/1.0' } }, 10000);
  if (!response.ok) throw new Error('OKX_PRICE_UNAVAILABLE');
  const payload = await response.json();
  const price = Number(payload?.data?.[0]?.last);
  if (!price || price <= 0) throw new Error('OKX_PRICE_UNAVAILABLE');
  return price;
}

export async function packageQuote(id) {
  const pack = PACKAGES[id];
  if (!pack) return null;
  const piUsd = await getPiUsd();
  return { ...pack, piUsd, amountPi: Number((pack.usd / piUsd).toFixed(7)), quotedAt: new Date().toISOString() };
}


export async function ensureConversationOwner(supabase, conversationId, userId) {
  const { data, error } = await supabase.from('conversations').select('id,user_id').eq('id', conversationId).eq('user_id', userId).maybeSingle();
  if (error) throw appError('DATABASE_ERROR', {}, error);
  if (!data) throw appError('FORBIDDEN');
  return data;
}

export function normalizeRequestId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) throw appError('INVALID_REQUEST');
  return id;
}

export async function reserveAiTokens(supabase, userId, requestId, kind, amount) {
  const { data, error } = await supabase.rpc('reserve_ai_tokens', { p_user_id:userId, p_request_id:requestId, p_kind:kind, p_amount:Math.max(1,Math.ceil(Number(amount)||1)) });
  if (error) {
    const m=String(error.message||'').toLowerCase();
    if (m.includes('already in progress')) throw appError('REQUEST_IN_PROGRESS');
    if (m.includes('insufficient')) throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST');
    if (m.includes('trial ended')) throw appError('TRIAL_ENDED');
    throw appError('DATABASE_ERROR',{},error);
  }
  if (data?.status === 'completed' || data?.status === 'released') throw appError('REQUEST_ALREADY_PROCESSED');
  return data || {};
}

export async function finalizeAiTokens(supabase,userId,requestId,actual,meta={}) {
  const { data,error }=await supabase.rpc('finalize_ai_tokens',{p_user_id:userId,p_request_id:requestId,p_actual:Math.max(1,Math.ceil(Number(actual)||1)),p_meta:meta});
  if(error) throw appError('DATABASE_ERROR',{},error);
  return Math.max(0,Number(data||0));
}

export async function releaseAiTokens(supabase,userId,requestId,meta={}) {
  if(!requestId) return;
  const { error }=await supabase.rpc('release_ai_tokens',{p_user_id:userId,p_request_id:requestId,p_meta:meta});
  if(error) console.error('Token reservation release failed:',error.message);
}


export function requestIp(req) {
  const candidates = [req?.headers?.['x-vercel-forwarded-for'], req?.headers?.['x-real-ip'], req?.socket?.remoteAddress];
  for (const candidate of candidates) {
    const value = String(candidate || '').split(',')[0].trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) || /^[0-9a-f:]+$/i.test(value)) return value.slice(0,80);
  }
  return 'unknown';
}
export async function enforceRateLimit(supabase,bucket,limit,windowSeconds) {
  const {data,error}=await supabase.rpc('check_api_rate_limit',{p_bucket:String(bucket).slice(0,180),p_limit:limit,p_window_seconds:windowSeconds});
  if(error) throw appError('DATABASE_ERROR',{},error);
  if(!data) throw appError('RATE_LIMITED');
}
