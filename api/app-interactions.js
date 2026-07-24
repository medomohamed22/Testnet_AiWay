import webpush from 'web-push';
import { allowMethods, appError, cleanText, db, handleError, json, localize, requestLocale, requireUser, requestIp, enforceRateLimit } from './_lib.js';

const REPORT_REASONS=['not_working','scam','wrong_link','impersonation','inappropriate','other'];

let vapidConfigured = false;
function ensureVapid() {
  const publicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  const privateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(process.env.VAPID_SUBJECT || 'mailto:support@aiway.app').trim();
  if (!publicKey || !privateKey) throw appError('MISSING_CONFIGURATION', { missing: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'] });
  if (!vapidConfigured) {
    webpush.setVapidDetails(subject, publicKey, privateKey);
    vapidConfigured = true;
  }
  return publicKey;
}

export async function sendPushToUser(supabase, userId, payload) {
  try { ensureVapid(); } catch { return { sent: 0 }; }
  const { data: subs, error } = await supabase
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .eq('user_id', userId);
  if (error || !subs?.length) return { sent: 0 };

  const body = JSON.stringify({
    title: payload?.title || 'AiWay',
    body: String(payload?.body || '').slice(0, 180),
    url: payload?.url || '/',
    tag: payload?.tag || 'aiway-notification'
  });

  let sent = 0;
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body
      );
      sent++;
    } catch (error) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await supabase.from('push_subscriptions').delete().eq('id', sub.id);
      } else {
        console.error('[PUSH_SEND_FAILED]', sub.id, error?.statusCode || error?.message);
      }
    }
  }));
  return { sent };
}

async function handlePush(req, res, locale) {
  const action = String(req.query?.action || req.body?.action || '').trim();

  if (req.method === 'GET' && action === 'vapid-public-key') {
    const publicKey = ensureVapid();
    return json(res, 200, { publicKey });
  }

  const user = await requireUser(req);
  const supabase = db();
  await enforceRateLimit(supabase, `push:${user.id}:${requestIp(req)}`, 20, 60);

  if (req.method === 'POST' && action === 'subscribe') {
    const subscription = req.body?.subscription;
    const endpoint = cleanText(subscription?.endpoint, 500);
    const p256dh = cleanText(subscription?.keys?.p256dh, 300);
    const authKey = cleanText(subscription?.keys?.auth, 300);
    if (!endpoint || !p256dh || !authKey) throw appError('INVALID_REQUEST');
    const { error } = await supabase.from('push_subscriptions').upsert({
      user_id: user.id,
      endpoint,
      p256dh,
      auth: authKey,
      user_agent: cleanText(req.headers['user-agent'], 300),
      last_seen_at: new Date().toISOString()
    }, { onConflict: 'endpoint' });
    if (error) throw appError('DATABASE_ERROR', {}, error);
    return json(res, 200, { subscribed: true });
  }

  if (req.method === 'POST' && action === 'unsubscribe') {
    const endpoint = cleanText(req.body?.endpoint, 500);
    if (endpoint) await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint).eq('user_id', user.id);
    return json(res, 200, { subscribed: false });
  }

  if (req.method === 'POST' && action === 'send-test') {
    const result = await sendPushToUser(supabase, user.id, {
      title: 'AiWay',
      body: localize(locale, 'هذا إشعار تجريبي من AiWay.', 'This is a test notification from AiWay.'),
      url: '/'
    });
    return json(res, 200, result);
  }

  throw appError('INVALID_REQUEST');
}

async function handleAppInteractions(req,res,locale){
  const supabase=db();
  if(req.method==='GET'){
    const user=await requireUser(req);
    const appId=String(req.query?.appId||'');
    if(!appId)return json(res,400,{error:localize(locale,'معرّف التطبيق مطلوب.','App id is required.'),code:'INVALID_REQUEST'});
    const {data,error}=await supabase.from('app_ratings').select('stars').eq('app_id',appId).eq('user_id',user.id).maybeSingle();
    if(error)throw error;
    return json(res,200,{stars:data?.stars||0});
  }
  const body=req.body||{};
  const action=String(body.action||'');
  const appId=String(body.appId||'');
  if(!appId)return json(res,400,{error:localize(locale,'معرّف التطبيق مطلوب.','App id is required.'),code:'INVALID_REQUEST'});
  const {data:app,error:appError}=await supabase.from('apps').select('id,status').eq('id',appId).maybeSingle();
  if(appError)throw appError;
  if(!app||app.status!=='published')return json(res,404,{error:localize(locale,'التطبيق غير موجود أو غير منشور.','The app was not found or is not published.'),code:'FILE_NOT_FOUND'});

  if(action==='view'||action==='get_click'){
    const visitorId=cleanText(body.visitorId,100);
    if(!/^[a-zA-Z0-9_-]{16,100}$/.test(visitorId))return json(res,400,{error:localize(locale,'معرّف الزائر غير صالح.','The visitor id is invalid.'),code:'INVALID_REQUEST'});
    const {error}=await supabase.from('app_events').insert({app_id:appId,visitor_id:visitorId,event_type:action});
    if(error&&error.code!=='23505')throw error;
    const {data:counts}=await supabase.from('apps').select('views_count,get_clicks_count').eq('id',appId).single();
    return json(res,200,{recorded:!error,counts});
  }

  const user=await requireUser(req);
  if(action==='rate'){
    const stars=Number(body.stars);
    if(!Number.isInteger(stars)||stars<1||stars>5)return json(res,400,{error:localize(locale,'اختر تقييمًا من نجمة واحدة إلى خمس نجوم.','Choose a rating from 1 to 5 stars.'),code:'INVALID_REQUEST'});
    const {error}=await supabase.from('app_ratings').upsert({app_id:appId,user_id:user.id,stars},{onConflict:'app_id,user_id'});
    if(error)throw error;
    const {data:rating}=await supabase.from('apps').select('rating,ratings_count').eq('id',appId).single();
    return json(res,200,{rating,userStars:stars});
  }
  if(action==='report'){
    const reason=String(body.reason||'');
    if(!REPORT_REASONS.includes(reason))return json(res,400,{error:localize(locale,'اختر سببًا صحيحًا للإبلاغ.','Choose a valid report reason.'),code:'INVALID_REQUEST'});
    const details=cleanText(body.details,500);
    const {error}=await supabase.from('app_reports').upsert({app_id:appId,reporter_id:user.id,reason,details,status:'open',reviewed_by:null,reviewed_at:null},{onConflict:'app_id,reporter_id'});
    if(error)throw error;
    return json(res,200,{reported:true});
  }
  return json(res,400,{error:localize(locale,'الإجراء المطلوب غير صالح.','The requested action is invalid.'),code:'INVALID_REQUEST'});
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  const locale=requestLocale(req);
  const mergedRoute=String(req.query?.__merged_route||'');
  try{
    if(mergedRoute==='push') return await handlePush(req,res,locale);
    return await handleAppInteractions(req,res,locale);
  }catch(error){
    const fallback=mergedRoute==='push'
      ? localize(locale,'تعذر تنفيذ طلب الإشعارات.','Could not complete the notification request.')
      : localize(locale,'تعذر حفظ الإجراء حاليًا.','Could not save the action right now.');
    return handleError(error,res,fallback,locale);
  }
}
