import { allowMethods, db, fetchWithTimeout, handleError, json, localize, requestLocale, requireUser, requireAdmin, MARKUP, TOKEN_USD, TRIAL_TOKENS, getPiUsd, getAdminConfig, saveAdminConfig, getOpenRouterCatalog } from './_lib.js';

const num=v=>{const n=Number(v||0);return Number.isFinite(n)?n:0};
const isoDay=v=>new Date(v).toISOString().slice(0,10);
const sinceDays=d=>new Date(Date.now()-d*86400000).toISOString();
const pct=(a,b)=>b?Math.round((a/b)*1000)/10:0;
async function fetchAll(factory,size=1000){const rows=[];for(let from=0;;from+=size){const {data,error}=await factory().range(from,from+size-1);if(error)throw error;rows.push(...(data||[]));if((data||[]).length<size)return rows}}
async function optional(factory,fallback=[]){try{return await fetchAll(factory)}catch(e){console.warn('Optional admin source unavailable:',e?.message);return fallback}}
function cost(u){return u&&typeof u==='object'?Math.max(0,num(u.providerUsd||u.cost)):0}
function charged(u){return u&&typeof u==='object'?Math.max(0,num(u.chargedTokens||u.tokens_charged)):0}
function latency(u){return u&&typeof u==='object'?Math.max(0,num(u.latency_ms||u.latencyMs||u.generation_time_ms||u.generationTimeMs)):0}
function tokens(u){if(!u||typeof u!=='object')return 0;return num(u.total_tokens||u.totalTokens)+num(u.prompt_tokens||u.promptTokens)+num(u.completion_tokens||u.completionTokens)}
function groupDaily(rows,dateKey,days=30){const out=[];for(let i=days-1;i>=0;i--){const d=new Date(Date.now()-i*86400000).toISOString().slice(0,10);out.push({date:d,value:0})}const map=new Map(out.map(x=>[x.date,x]));for(const r of rows){const raw=r[dateKey];if(!raw)continue;const x=map.get(isoDay(raw));if(x)x.value++}return out}
async function openRouter(){
  const key=process.env.OPENROUTER_API_KEY;
  if(!key)return {configured:false,status:'missing',credits:null,key:null};
  const headers={Authorization:`Bearer ${key}`};
  const [creditRes,keyRes]=await Promise.allSettled([
    fetchWithTimeout('https://openrouter.ai/api/v1/credits',{headers},12000),
    fetchWithTimeout('https://openrouter.ai/api/v1/key',{headers},12000)
  ]);
  let credits=null,keyInfo=null,status='ok';
  if(creditRes.status==='fulfilled'){const p=await creditRes.value.json().catch(()=>({}));if(creditRes.value.ok){const d=p.data||{};credits={total:num(d.total_credits),used:num(d.total_usage),remaining:Math.max(0,num(d.total_credits)-num(d.total_usage))}}else status='limited'}else status='offline';
  if(keyRes.status==='fulfilled'){const p=await keyRes.value.json().catch(()=>({}));if(keyRes.value.ok){const d=p.data||{};keyInfo={label:d.label||null,limit:num(d.limit),usage:num(d.usage),limitRemaining:num(d.limit_remaining),isFreeTier:!!d.is_free_tier,rateLimit:d.rate_limit||null}}}
  return {configured:true,status,credits,key:keyInfo};
}

async function adminImageCatalog(){
  try{
    const r=await fetchWithTimeout('https://openrouter.ai/api/v1/images/models',{headers:process.env.OPENROUTER_API_KEY?{Authorization:`Bearer ${process.env.OPENROUTER_API_KEY}`}:{},},15000);
    if(!r.ok)return [];
    const p=await r.json();
    return (p.data||[]).filter(m=>m?.id&&m.architecture?.output_modalities?.includes('image')).map(m=>({
      id:m.id,name:m.name||m.id,type:'image',provider:String(m.id).split('/')[0],description:m.description||'',created:num(m.created),
      isFree:[m.pricing?.request,m.pricing?.image,m.pricing?.image_output].filter(v=>v!==undefined&&v!==null&&v!=='').map(Number).every(v=>v===0),
      cost:Number(m.pricing?.request??m.pricing?.image??m.pricing?.image_output??0),pricing:m.pricing||{}
    })).sort((a,b)=>a.cost-b.cost||a.name.localeCompare(b.name));
  }catch{return []}
}
function cleanCategory(c,index){
  const id=String(c?.id||'').trim().toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,40);
  if(!id)return null;
  return {id,ar:String(c?.ar||id).trim().slice(0,60),en:String(c?.en||c?.ar||id).trim().slice(0,60),order:Number(c?.order||index+1)};
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  const locale=requestLocale(req);
  try{
    const admin=await requireUser(req);await requireAdmin(admin);const s=db();
    if(req.method==='POST'){
      const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
      if(body.action==='set-user-ban'){
        const userId=String(body.userId||'').trim();
        if(!userId)return json(res,400,{error:'معرّف المستخدم مطلوب.',code:'USER_REQUIRED'});
        const result=await s.from('users').update({is_banned:Boolean(body.banned),updated_at:new Date().toISOString()}).eq('id',userId).eq('role','user').select('id,username,is_banned').maybeSingle();
        if(result.error)throw result.error;
        if(!result.data)return json(res,404,{error:'المستخدم غير موجود.',code:'USER_NOT_FOUND'});
        return json(res,200,{ok:true,user:result.data});
      }
      if(body.action==='save-catalog'){
        const current=await getAdminConfig({fresh:true});
        const categories=(Array.isArray(body.categories)?body.categories:current.categories).map(cleanCategory).filter(Boolean).slice(0,30);
        const incoming=body.models&&typeof body.models==='object'?body.models:{};
        const models={};
        for(const [id,v] of Object.entries(incoming).slice(0,5000)) models[String(id).slice(0,220)]={visible:Boolean(v?.visible),categoryId:String(v?.categoryId||'recommended').slice(0,40),order:Math.max(0,Number(v?.order||9999))};
        const saved=await saveAdminConfig({...current,categories,models});
        return json(res,200,{ok:true,config:saved});
      }
      if(body.action==='save-packages'){
        const current=await getAdminConfig({fresh:true});const packages={};
        for(const id of ['starter','plus','pro']){
          const src=body.packages?.[id]||current.packages?.[id]||{};
          const usd=Math.max(.01,Number(src.usd||0));const tokens=Math.max(1,Math.floor(Number(src.tokens||0)));
          packages[id]={usd,tokens};
        }
        const saved=await saveAdminConfig({...current,packages});
        return json(res,200,{ok:true,packages:saved.packages});
      }
      return json(res,400,{error:'إجراء إدارة غير صالح.',code:'INVALID_ACTION'});
    }
    const expirySweep=await s.rpc('expire_all_paid_tokens');if(expirySweep.error)throw expirySweep.error;
    const [users,payments,messages,images,conversations,reservations,openRouterInfo]=await Promise.all([
      fetchAll(()=>s.from('users').select('id,pi_uid,username,role,is_banned,ai_tokens,paid_ai_tokens,paid_tokens_expires_at,trial_messages_remaining,has_purchased,last_login_at,created_at,updated_at').eq('role','user').order('created_at',{ascending:false})),
      fetchAll(()=>s.from('payments').select('id,user_id,amount_pi,usd_amount,status,package_id,ai_tokens,created_at,completed_at').order('created_at',{ascending:false})),
      fetchAll(()=>s.from('messages').select('id,user_id,conversation_id,role,model_id,token_usage,created_at').order('created_at',{ascending:false})),
      optional(()=>s.from('generated_images').select('id,user_id,model_id,width,height,token_usage,created_at').order('created_at',{ascending:false})),
      fetchAll(()=>s.from('conversations').select('id,user_id,model_id,created_at,updated_at').order('updated_at',{ascending:false})),
      optional(()=>s.from('ai_usage_reservations').select('id,user_id,kind,reserved_tokens,charged_tokens,status,response_meta,created_at,completed_at').order('created_at',{ascending:false})),
      openRouter()
    ]);
    const now=Date.now(), day1=now-86400000, day7=now-7*86400000, day30=now-30*86400000;
    const assistants=messages.filter(x=>x.role==='assistant');const userMsgs=messages.filter(x=>x.role==='user');
    const completed=payments.filter(x=>x.status==='completed');
    const userMap=new Map(users.map(u=>[u.id,{...u,messages:0,images:0,costUsd:0,chargedTokens:0,models:new Map(),lastActivity:u.last_login_at||u.updated_at||u.created_at}]));
    for(const m of assistants){const u=userMap.get(m.user_id);if(!u)continue;u.messages++;u.costUsd+=cost(m.token_usage);u.chargedTokens+=charged(m.token_usage);if(m.model_id)u.models.set(m.model_id,(u.models.get(m.model_id)||0)+1);if(new Date(m.created_at)>new Date(u.lastActivity))u.lastActivity=m.created_at}
    for(const im of images){const u=userMap.get(im.user_id);if(u){u.images++;u.costUsd+=cost(im.token_usage);u.chargedTokens+=charged(im.token_usage);if(im.model_id)u.models.set(im.model_id,(u.models.get(im.model_id)||0)+1);if(new Date(im.created_at)>new Date(u.lastActivity))u.lastActivity=im.created_at}}
    const paidByUser=new Map();for(const p of completed)paidByUser.set(p.user_id,(paidByUser.get(p.user_id)||0)+num(p.usd_amount));
    const usersTable=[...userMap.values()].map(u=>{const paidUsd=paidByUser.get(u.id)||0;const openRouterReserveUsd=paidUsd/MARKUP;const paidBalanceTokens=Math.max(0,num(u.paid_ai_tokens));return {id:u.id,pi_uid:u.pi_uid,username:u.username,balance:num(u.ai_tokens),paidBalanceTokens,paidTokensExpireAt:u.paid_tokens_expires_at,purchased:!!u.has_purchased,trialRemaining:num(u.trial_messages_remaining),registeredAt:u.created_at,isBanned:Boolean(u.is_banned),lastLoginAt:u.last_login_at,lastActivity:u.lastActivity,messages:u.messages,images:u.images,providerCostUsd:u.costUsd,chargedTokens:u.chargedTokens,paidUsd,openRouterReserveUsd,profitUsd:paidUsd-openRouterReserveUsd,topModel:[...u.models.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'—'}});
    const modelMap=new Map();for(const m of assistants){const id=m.model_id||'غير محدد';const x=modelMap.get(id)||{model:id,requests:0,users:new Set(),costUsd:0,chargedTokens:0,inputTokens:0,outputTokens:0,totalTokens:0,latencyTotal:0,latencyCount:0};x.requests++;x.users.add(m.user_id);x.costUsd+=cost(m.token_usage);x.chargedTokens+=charged(m.token_usage);x.inputTokens+=num(m.token_usage?.prompt_tokens||m.token_usage?.promptTokens);x.outputTokens+=num(m.token_usage?.completion_tokens||m.token_usage?.completionTokens);x.totalTokens+=tokens(m.token_usage);const l=latency(m.token_usage);if(l){x.latencyTotal+=l;x.latencyCount++}modelMap.set(id,x)}
    const models=[...modelMap.values()].map(x=>({model:x.model,requests:x.requests,users:x.users.size,costUsd:x.costUsd,chargedTokens:x.chargedTokens,inputTokens:x.inputTokens,outputTokens:x.outputTokens,totalTokens:x.totalTokens,avgCostUsd:x.requests?x.costUsd/x.requests:0,avgLatencyMs:x.latencyCount?x.latencyTotal/x.latencyCount:0,revenueUsd:x.chargedTokens*TOKEN_USD*MARKUP,profitUsd:x.chargedTokens*TOKEN_USD*MARKUP-x.costUsd})).sort((a,b)=>b.requests-a.requests);
    const imageModels=new Map();for(const im of images){const id=im.model_id||'غير محدد';const x=imageModels.get(id)||{model:id,requests:0,costUsd:0,chargedTokens:0,sizes:new Map()};x.requests++;x.costUsd+=cost(im.token_usage);x.chargedTokens+=charged(im.token_usage);const size=im.width&&im.height?`${im.width}×${im.height}`:(im.token_usage?.resolution||im.token_usage?.aspectRatio||'غير محدد');x.sizes.set(size,(x.sizes.get(size)||0)+1);imageModels.set(id,x)}
    const imageAnalytics=[...imageModels.values()].map(x=>({model:x.model,requests:x.requests,costUsd:x.costUsd,avgCostUsd:x.requests?x.costUsd/x.requests:0,chargedTokens:x.chargedTokens,profitUsd:x.chargedTokens*TOKEN_USD*MARKUP-x.costUsd,topSize:[...x.sizes.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||'—'})).sort((a,b)=>b.requests-a.requests);
    const messageProviderCostUsd=assistants.reduce((a,m)=>a+cost(m.token_usage),0);const imageProviderCostUsd=images.reduce((a,i)=>a+cost(i.token_usage),0);const providerCostUsd=messageProviderCostUsd+imageProviderCostUsd;const totalUsd=completed.reduce((a,p)=>a+num(p.usd_amount),0);const totalPi=completed.reduce((a,p)=>a+num(p.amount_pi),0);const issuedPaidTokens=completed.reduce((a,p)=>a+num(p.ai_tokens),0);const remainingUserTokens=users.reduce((a,u)=>a+num(u.ai_tokens),0);const paidUsersRemainingTokens=users.reduce((a,u)=>a+Math.max(0,num(u.paid_ai_tokens)),0);
    const active=(ms)=>users.filter(u=>new Date(userMap.get(u.id)?.lastActivity||0).getTime()>=ms).length;
    const newUsers=(ms)=>users.filter(u=>new Date(u.created_at).getTime()>=ms).length;
    const errors=reservations.filter(r=>r.status==='released');const successful=reservations.filter(r=>r.status==='completed');
    const dailyMessages=groupDaily(assistants,'created_at');const dailyImages=groupDaily(images,'created_at');const dailyUsers=[];for(let i=29;i>=0;i--){const date=new Date(now-i*86400000).toISOString().slice(0,10);const set=new Set(messages.filter(m=>isoDay(m.created_at)===date).map(m=>m.user_id));dailyUsers.push({date,value:set.size})}
    const hourCounts=Array.from({length:24},(_,hour)=>({hour,value:0}));for(const m of messages){hourCounts[new Date(m.created_at).getUTCHours()].value++}
    const retentionBase=users.filter(u=>new Date(u.created_at).getTime()<day7);const retained7=retentionBase.filter(u=>new Date(userMap.get(u.id)?.lastActivity||0).getTime()>=new Date(u.created_at).getTime()+7*86400000).length;
    let currentPiUsd=null;try{currentPiUsd=await getPiUsd()}catch{}
    const providerSharePercent=100/MARKUP;const ownerProfitPercent=100-providerSharePercent;const openRouterReserveFromSalesUsd=totalUsd/MARKUP;const ownerGrossProfitFromSalesUsd=totalUsd-openRouterReserveFromSalesUsd;const openRouterAvailableUsd=openRouterInfo.credits?.remaining??null;const openRouterRequiredForBalancesUsd=paidUsersRemainingTokens*TOKEN_USD;const openRouterTopUpRequiredUsd=openRouterAvailableUsd==null?null:Math.max(0,openRouterRequiredForBalancesUsd-openRouterAvailableUsd);const openRouterCoveragePercent=openRouterRequiredForBalancesUsd?Math.min(100,pct(openRouterAvailableUsd||0,openRouterRequiredForBalancesUsd)):100;
    const pending=payments.filter(p=>p.status==='approved').length,failedPayments=payments.filter(p=>['failed','cancelled'].includes(p.status)).length;
    const [adminConfig,allChatModels,allImageModels]=await Promise.all([getAdminConfig({fresh:true}),getOpenRouterCatalog(),adminImageCatalog()]);
    const adminCatalog={config:adminConfig,chatModels:allChatModels.map(m=>({id:m.id,name:m.name,type:'chat',provider:m.tag||m.family,isFree:!!m.isFree,cost:(num(m.pricing?.prompt)+num(m.pricing?.completion))*1000000,pricing:m.pricing||{},description:m.description||''})),imageModels:allImageModels};
    return json(res,200,{
      generatedAt:new Date().toISOString(), adminCatalog, users:users.length,buyers:users.filter(u=>u.has_purchased).length,purchaseRequests:payments.length,completedPurchases:completed.length,totalPi,totalUsd,currentPiUsd,markup:MARKUP,expectedMarkupPercent:(MARKUP-1)*100,expectedMarginPercent:ownerProfitPercent,providerSharePercent,ownerProfitPercent,tokenUsd:TOKEN_USD,issuedPaidTokens,soldProviderCapacityUsd:issuedPaidTokens*TOKEN_USD,openRouterReserveFromSalesUsd,ownerGrossProfitFromSalesUsd,providerCostUsd,messageProviderCostUsd,imageProviderCostUsd,remainingUserTokens,paidUsersRemainingTokens,excludedTrialTokens:users.reduce((a,u)=>a+Math.max(0,num(u.ai_tokens)-num(u.paid_ai_tokens)),0),remainingProviderLiabilityUsd:openRouterRequiredForBalancesUsd,openRouterRequiredForBalancesUsd,openRouterAvailableUsd,openRouterTopUpRequiredUsd,openRouterCoveragePercent,expectedGrossProfitUsd:ownerGrossProfitFromSalesUsd,realizedGrossProfitUsd:ownerGrossProfitFromSalesUsd,realizedGrossProfitPi:totalUsd&&totalPi?ownerGrossProfitFromSalesUsd*(totalPi/totalUsd):0,
      overview:{activeToday:active(day1),active7d:active(day7),active30d:active(day30),newToday:newUsers(day1),new7d:newUsers(day7),messagesToday:assistants.filter(m=>new Date(m.created_at).getTime()>=day1).length,imagesToday:images.filter(i=>new Date(i.created_at).getTime()>=day1).length,requestsToday:reservations.filter(r=>new Date(r.created_at).getTime()>=day1).length,errorRate:pct(errors.length,reservations.length)},
      usersTable,models,imageAnalytics,
      usage:{dailyMessages,dailyImages,dailyUsers,hourCounts,dau:active(day1),wau:active(day7),mau:active(day30),retention7d:pct(retained7,retentionBase.length),returningUsers:users.filter(u=>new Date(u.created_at).getTime()<day30&&new Date(userMap.get(u.id)?.lastActivity||0).getTime()>=day30).length},
      messages:{count:assistants.length,costUsd:messageProviderCostUsd,avgCostUsd:assistants.length?messageProviderCostUsd/assistants.length:0,avgChargedTokens:assistants.length?assistants.reduce((a,m)=>a+charged(m.token_usage),0)/assistants.length:0,avgLatencyMs:(()=>{const a=assistants.map(m=>latency(m.token_usage)).filter(Boolean);return a.length?a.reduce((x,y)=>x+y,0)/a.length:0})()},
      images:{count:images.length,costUsd:images.reduce((a,i)=>a+cost(i.token_usage),0),avgCostUsd:images.length?images.reduce((a,i)=>a+cost(i.token_usage),0)/images.length:0},
      finance:{pendingPayments:pending,failedPayments,topSpenders:usersTable.slice().sort((a,b)=>b.paidUsd-a.paidUsd).slice(0,10),totalBalances:remainingUserTokens,paidUsersRemainingTokens,excludedTrialTokens:users.reduce((a,u)=>a+Math.max(0,num(u.ai_tokens)-num(u.paid_ai_tokens)),0),providerSharePercent,ownerProfitPercent,openRouterReserveFromSalesUsd,ownerGrossProfitFromSalesUsd,openRouterRequiredForBalancesUsd,openRouterAvailableUsd,openRouterTopUpRequiredUsd,openRouterCoveragePercent},
      api:{openRouter:openRouterInfo,database:{status:'ok',rowsRead:users.length+payments.length+messages.length+images.length+conversations.length+reservations.length},requests:reservations.length,success:successful.length,errors:errors.length,recentErrors:errors.slice(0,20).map(r=>({kind:r.kind,createdAt:r.created_at,code:r.response_meta?.code||'REQUEST_RELEASED',userId:r.user_id}))},
      alerts:[
        ...(openRouterInfo.credits&&openRouterInfo.credits.remaining<5?[{level:'danger',title:'رصيد OpenRouter منخفض',message:`المتبقي $${openRouterInfo.credits.remaining.toFixed(2)}`}]:[]),
        ...(pct(errors.length,reservations.length)>5?[{level:'danger',title:'ارتفاع نسبة الأخطاء',message:`نسبة الأخطاء ${pct(errors.length,reservations.length)}٪`}]:[]),
        ...(pending>0?[{level:'warning',title:'مدفوعات معلقة',message:`يوجد ${pending} طلب دفع معلق`}]:[]),
        ...(openRouterRequiredForBalancesUsd>(openRouterInfo.credits?.remaining||Infinity)?[{level:'warning',title:'التزام الرصيد أعلى من رصيد المزود',message:'راجع رصيد OpenRouter ورصيد المستخدمين.'}]:[])
      ],
      reports:{today:{newUsers:newUsers(day1),activeUsers:active(day1),messages:assistants.filter(m=>new Date(m.created_at).getTime()>=day1).length,images:images.filter(i=>new Date(i.created_at).getTime()>=day1).length},week:{newUsers:newUsers(day7),activeUsers:active(day7),messages:assistants.filter(m=>new Date(m.created_at).getTime()>=day7).length,images:images.filter(i=>new Date(i.created_at).getTime()>=day7).length}}
    });
  }catch(error){return handleError(error,res,localize(locale,'تعذر تحميل إحصاءات الإدارة.','Could not load admin analytics.'),locale)}
}
