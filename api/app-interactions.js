import { allowMethods, cleanText, db, handleError, json, localize, requestLocale, requireUser, enforceRateLimit, requestIp } from './_lib.js';

const REPORT_REASONS=['not_working','scam','wrong_link','impersonation','inappropriate','other'];

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  const locale=requestLocale(req);
  try{
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
      await enforceRateLimit(supabase,`app-event:ip:${requestIp(req)}`,60,60);
      await enforceRateLimit(supabase,`app-event:${appId}:${requestIp(req)}`,20,60);
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
  }catch(error){return handleError(error,res,localize(locale,'تعذر حفظ الإجراء حاليًا.','Could not save the action right now.'),locale)}
}
