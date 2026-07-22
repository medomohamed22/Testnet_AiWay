import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { allowMethods, appError, db, handleError, json, localize, piApiError, requestLocale, signAppToken, requestIp, enforceRateLimit } from './_lib.js';

const BRIDGE_TTL_MS = 10 * 60 * 1000;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  try {
    const left = Buffer.from(String(a), 'hex');
    const right = Buffer.from(String(b), 'hex');
    return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function bridgeStateSignature(requestId) {
  const secret = String(process.env.APP_JWT_SECRET || '');
  if (!secret) throw appError('SERVER_CONFIG_ERROR');
  return createHmac('sha256', secret)
    .update(`${requestId}:pi-signin-state`)
    .digest('base64url')
    .slice(0, 22);
}

function createBridgeState(requestId) {
  return `${requestId}.${bridgeStateSignature(requestId)}`;
}

function parseBridgeState(value) {
  const raw = String(value || '').trim();
  const dot = raw.indexOf('.');
  if (dot < 1) return null;
  const requestId = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!/^[0-9a-f-]{36}$/i.test(requestId) || !/^[A-Za-z0-9_-]{22}$/.test(signature)) return null;
  const expected = bridgeStateSignature(requestId);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { requestId };
}

function exchangeCode(requestId, pollToken) {
  const secret = String(process.env.APP_JWT_SECRET || '');
  return createHmac('sha256', secret).update(`${requestId}:${pollToken}:pi-login-bridge`).digest('base64url');
}

async function verifyPiAccessToken(accessToken) {
  const base = String(process.env.PI_API_BASE_URL || 'https://api.minepi.com').replace(/\/$/, '');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  let response;
  try {
    response = await fetch(`${base}/v2/me`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
  } finally {
    clearTimeout(timeout);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Pi /v2/me failed', response.status, payload);
    throw piApiError(response.status, payload, { operation: 'login' });
  }
  const piUid = String(payload.uid || '').trim();
  const username = String(payload.username || '').trim();
  if (!piUid || !username) throw appError('PI_LOGIN_FAILED');
  return { piUid, username };
}

async function upsertPiUser(supabase, piUid, username) {
  const { data: user, error } = await supabase
    .from('users')
    .upsert({ pi_uid: piUid, username, last_login_at: new Date().toISOString() }, { onConflict: 'pi_uid' })
    .select('id, pi_uid, username, role, ai_tokens, trial_messages_remaining, has_purchased, created_at')
    .single();
  if (error || !user) throw appError('DATABASE_ERROR', {}, error);
  return user;
}

async function readBridge(supabase, requestId) {
  const { data, error } = await supabase
    .from('pi_login_requests')
    .select('id, poll_token_hash, status, user_id, expires_at, consumed_at')
    .eq('id', requestId)
    .maybeSingle();
  if (error) throw appError('DATABASE_ERROR', {}, error);
  return data;
}

function bridgeValid(row, pollToken) {
  return row && !row.consumed_at && new Date(row.expires_at).getTime() > Date.now() && safeEqualHex(row.poll_token_hash, sha256(pollToken));
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const locale = requestLocale(req);
  try {
    const supabase = db();
    const ip = requestIp(req);
    const action = String(req.body?.action || 'login').trim();

    if (action === 'bridge-start') {
      await enforceRateLimit(supabase, `pi-bridge-start:${ip}`, 8, 60);
      const requestId = randomUUID();
      const pollToken = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + BRIDGE_TTL_MS).toISOString();
      const { error } = await supabase.from('pi_login_requests').insert({
        id: requestId,
        poll_token_hash: sha256(pollToken),
        status: 'pending',
        expires_at: expiresAt,
        request_ip: ip
      });
      if (error) throw appError('DATABASE_ERROR', {}, error);
      return json(res, 200, { requestId, pollToken, state: createBridgeState(requestId), expiresAt });
    }

    if (action === 'bridge-complete') {
      await enforceRateLimit(supabase, `pi-bridge-complete:${ip}`, 12, 60);
      const accessToken = String(req.body?.accessToken || '').trim();
      const parsed = parseBridgeState(req.body?.state);
      if (!accessToken || !parsed) throw appError('INVALID_REQUEST');
      const row = await readBridge(supabase, parsed.requestId);
      if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now() || row.status !== 'pending') throw appError('PI_LOGIN_BRIDGE_EXPIRED');
      let piIdentity;
      try {
        piIdentity = await verifyPiAccessToken(accessToken);
      } catch (error) {
        console.error('[PI_BRIDGE_COMPLETE_FAILED]', { stage: 'verify-token', requestId: parsed.requestId, code: error?.code, message: error?.message });
        throw error;
      }
      const { piUid, username } = piIdentity;
      let user;
      try {
        user = await upsertPiUser(supabase, piUid, username);
      } catch (error) {
        console.error('[PI_BRIDGE_COMPLETE_FAILED]', { stage: 'upsert-user', requestId: parsed.requestId, piUid, username, code: error?.code, message: error?.message });
        throw error;
      }
      const { data: updated, error } = await supabase
        .from('pi_login_requests')
        .update({ status: 'completed', user_id: user.id, completed_at: new Date().toISOString() })
        .eq('id', parsed.requestId)
        .eq('status', 'pending')
        .is('consumed_at', null)
        .select('id')
        .maybeSingle();
      if (error) throw appError('DATABASE_ERROR', {}, error);
      if (!updated) throw appError('PI_LOGIN_BRIDGE_EXPIRED');
      return json(res, 200, { completed: true, username: user.username });
    }

    if (action === 'bridge-status') {
      await enforceRateLimit(supabase, `pi-bridge-status:${ip}`, 90, 60);
      const requestId = String(req.body?.requestId || '').trim();
      const pollToken = String(req.body?.pollToken || '').trim();
      const row = await readBridge(supabase, requestId);
      if (!bridgeValid(row, pollToken)) throw appError('PI_LOGIN_BRIDGE_EXPIRED');
      if (row.status !== 'completed' || !row.user_id) return json(res, 200, { status: 'pending' });
      return json(res, 200, { status: 'completed', exchangeCode: exchangeCode(requestId, pollToken) });
    }

    if (action === 'bridge-exchange') {
      await enforceRateLimit(supabase, `pi-bridge-exchange:${ip}`, 12, 60);
      const requestId = String(req.body?.requestId || '').trim();
      const pollToken = String(req.body?.pollToken || '').trim();
      const code = String(req.body?.exchangeCode || '').trim();
      const expectedCode = exchangeCode(requestId, pollToken);
      if (!code || code.length !== expectedCode.length || !timingSafeEqual(Buffer.from(code), Buffer.from(expectedCode))) throw appError('UNAUTHORIZED');
      const row = await readBridge(supabase, requestId);
      if (!bridgeValid(row, pollToken) || row.status !== 'completed' || !row.user_id) throw appError('PI_LOGIN_BRIDGE_EXPIRED');
      const { data: consumed, error: consumeError } = await supabase
        .from('pi_login_requests')
        .update({ status: 'consumed', consumed_at: new Date().toISOString() })
        .eq('id', requestId)
        .eq('status', 'completed')
        .is('consumed_at', null)
        .select('user_id')
        .maybeSingle();
      if (consumeError) throw appError('DATABASE_ERROR', {}, consumeError);
      if (!consumed?.user_id) throw appError('PI_LOGIN_BRIDGE_EXPIRED');
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('id, pi_uid, username, role, ai_tokens, trial_messages_remaining, has_purchased, created_at')
        .eq('id', consumed.user_id)
        .single();
      if (userError || !user) throw appError('DATABASE_ERROR', {}, userError);
      const token = await signAppToken(user);
      return json(res, 200, { token, user });
    }

    await enforceRateLimit(supabase, `login:${ip}`, 10, 60);
    const accessToken = String(req.body?.accessToken || '').trim();
    if (!accessToken) return json(res, 400, {
      error: localize(locale, 'رمز تسجيل الدخول من Pi غير موجود. أعد فتح الموقع داخل Pi Browser وحاول مرة أخرى.', 'The Pi sign-in token is missing. Reopen the site in Pi Browser and try again.'),
      code: 'PI_LOGIN_FAILED'
    });
    const { piUid, username } = await verifyPiAccessToken(accessToken);
    const user = await upsertPiUser(supabase, piUid, username);
    const token = await signAppToken(user);
    return json(res, 200, { token, user });
  } catch (error) {
    if (error?.name === 'AbortError') return handleError(appError('REQUEST_TIMEOUT', {}, error), res, localize(locale, 'انتهت مهلة تسجيل الدخول. حاول مرة أخرى.', 'Sign-in timed out. Try again.'), locale);
    if (error?.code === 'PI_LOGIN_BRIDGE_EXPIRED') return json(res, 410, {
      error: localize(locale, 'انتهت صلاحية طلب تسجيل الدخول. ابدأ المحاولة من المتصفح الأصلي مرة أخرى.', 'The sign-in request expired. Start again from the original browser.'),
      code: 'PI_LOGIN_BRIDGE_EXPIRED'
    });
    return handleError(error, res, localize(locale, 'تعذر إكمال تسجيل الدخول حاليًا. حاول مرة أخرى بعد قليل.', 'Could not complete sign-in right now. Try again shortly.'), locale);
  }
}
