import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, PACKAGES, piApiError, requestLocale, requireUser, requestIp, enforceRateLimit, sendTelegramNotification, telegramHtml, formatCairoDateTime } from './_lib.js';

const piHeaders=()=>({Authorization:`Key ${process.env.PI_SECRET_KEY}`,'Content-Type':'application/json'});
async function piRequest(paymentId,action='',body){
  const suffix=action?`/${action}`:'';
  const options={method:action?'POST':'GET',headers:piHeaders()};
  if(body!==undefined)options.body=JSON.stringify(body);
  const response=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}${suffix}`,options,20000);
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw piApiError(response.status,data,{operation:'payment'});
  return data;
}
function owner(r){return String(r?.user_uid||r?.user?.uid||r?.metadata?.pi_uid||'').trim();}
function pkg(r){return String(r?.metadata?.packageId||r?.metadata?.package_id||'').trim();}
function closeEnough(a,b){
  const x=Number(a),y=Number(b);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0)return false;
  // Some existing databases stored Pi amounts at 3 decimal places.
  // Accept only the maximum legitimate rounding difference (half of 0.001 Pi),
  // while still rejecting any meaningful price/package manipulation.
  return Math.abs(x-y)<=0.00050001;
}
function norm(v){return String(v||'').trim();}
function mismatch(reason,details={}){console.error('[PAYMENT_MISMATCH]',{reason,...details});throw appError('PAYMENT_MISMATCH');}
function isCancelled(remote){return Boolean(remote?.status?.cancelled||remote?.status?.user_cancelled);}
function isCompleted(remote){return Boolean(remote?.status?.developer_completed);}
function verifiedTransaction(remote){
  const txid=norm(remote?.transaction?.txid);
  const verified=Boolean(remote?.transaction?.verified||remote?.status?.transaction_verified);
  return txid&&verified?txid:'';
}
async function markCancelled(supabase,userId,paymentId,remote,cancelResponse=null){
  const existing=await supabase.from('payments').select('user_id,status,raw_response').eq('payment_id',paymentId).maybeSingle();
  if(existing.error)throw appError('DATABASE_ERROR',{},existing.error);
  if(!existing.data)return;
  if(norm(existing.data.user_id)!==norm(userId))mismatch('PAYMENT_OWNER_DB',{paymentId,storedUserId:existing.data.user_id,currentUserId:userId});
  if(existing.data.status==='completed')return;
  const raw={...(existing.data.raw_response||{}),cancellation:cancelResponse,payment:remote};
  const updated=await supabase.from('payments').update({status:'cancelled',raw_response:raw}).eq('payment_id',paymentId).eq('user_id',userId).neq('status','completed');
  if(updated.error)throw appError('DATABASE_ERROR',{},updated.error);
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST']))return;
  const locale=requestLocale(req);
  try{
    const user=await requireUser(req);
    await enforceRateLimit(db(),`payment:${user.id}:${requestIp(req)}`,12,60);
    const paymentId=norm(req.body?.paymentId);
    const resolvePending=Boolean(req.body?.resolvePending||req.body?.recover);
    if(!paymentId)throw appError('PAYMENT_INVALID');
    if(!process.env.PI_SECRET_KEY)throw appError('MISSING_CONFIGURATION');

    const supabase=db();
    let remote=await piRequest(paymentId);
    const remoteOwner=owner(remote);
    if(!remoteOwner||remoteOwner!==norm(user.pi_uid))mismatch('PI_OWNER',{paymentId,remoteOwner,currentPiUid:user.pi_uid});

    // A pending payment with no submitted blockchain transaction is safe to cancel.
    // Never cancel a payment after a transaction exists: it must be verified/completed instead.
    if(resolvePending&&!remote?.transaction&&!isCompleted(remote)){
      if(!isCancelled(remote)){
        const cancelled=await piRequest(paymentId,'cancel');
        remote=cancelled||remote;
        await markCancelled(supabase,user.id,paymentId,remote,cancelled);
      }else{
        await markCancelled(supabase,user.id,paymentId,remote);
      }
      return json(res,200,{resolved:true,cancelled:true,paymentId});
    }

    if(isCancelled(remote)){
      await markCancelled(supabase,user.id,paymentId,remote);
      return json(res,200,{resolved:true,cancelled:true,paymentId});
    }

    const found=await supabase.from('payments').select('*').eq('payment_id',paymentId).maybeSingle();
    if(found.error)throw appError('DATABASE_ERROR',{},found.error);
    const payment=found.data;
    if(!payment)mismatch('PAYMENT_NOT_FOUND',{paymentId,userId:user.id});
    if(norm(payment.user_id)!==norm(user.id))mismatch('PAYMENT_OWNER_DB',{paymentId,storedUserId:payment.user_id,currentUserId:user.id});
    if(payment.status==='completed')return json(res,200,{completed:true,resolved:true,tokens:payment.ai_tokens,alreadyCompleted:true});

    const remotePackage=pkg(remote);
    if(remotePackage!==norm(payment.package_id)||!PACKAGES[remotePackage])mismatch('PACKAGE',{paymentId,remotePackage,storedPackage:payment.package_id});
    if(!closeEnough(remote.amount,payment.amount_pi))mismatch('AMOUNT',{paymentId,remoteAmount:remote.amount,storedAmount:payment.amount_pi});
    if(Number(payment.ai_tokens)!==Number(PACKAGES[remotePackage].tokens))mismatch('TOKENS',{paymentId,storedTokens:payment.ai_tokens,expectedTokens:PACKAGES[remotePackage].tokens});

    const remoteTx=verifiedTransaction(remote);
    if(!remoteTx)throw appError('PAYMENT_PENDING');
    const clientTx=norm(req.body?.txid);
    if(clientTx&&clientTx.toLowerCase()!==remoteTx.toLowerCase())console.warn('[PAYMENT_TXID_CALLBACK_DIFFERENCE]',{paymentId,clientTx,remoteTx});

    let completion=remote;
    if(!isCompleted(remote)){
      try{completion=await piRequest(paymentId,'complete',{txid:remoteTx});}
      catch(error){
        // Re-read once: Pi may have completed it while this request was in flight.
        const latest=await piRequest(paymentId);
        if(!isCompleted(latest))throw error;
        completion=latest;
      }
    }

    const {error}=await supabase.rpc('complete_token_purchase',{p_user_id:user.id,p_payment_id:paymentId,p_txid:remoteTx,p_tokens:payment.ai_tokens,p_raw:{completion,payment:remote}});
    if(error){
      const done=await supabase.from('payments').select('status,ai_tokens').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();
      if(done.data?.status==='completed')return json(res,200,{completed:true,resolved:true,tokens:done.data.ai_tokens,alreadyCompleted:true});
      throw appError('DATABASE_ERROR',{},error);
    }
    await sendTelegramNotification(
      `💰 <b>دفعة جديدة مكتملة</b>\n\n`+
      `👤 <b>اسم المستخدم:</b> ${telegramHtml(user.username||'مستخدم Pi')}\n`+
      `🆔 <b>معرّف المستخدم:</b> <code>${telegramHtml(user.id)}</code>\n`+
      `🥧 <b>عدد Pi:</b> ${telegramHtml(Number(payment.amount_pi).toLocaleString('en-US',{maximumFractionDigits:7}))}\n`+
      `💵 <b>القيمة بالدولار:</b> $${telegramHtml(Number(payment.usd_amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}))}\n`+
      `🪙 <b>التوكينات المشحونة:</b> ${telegramHtml(Number(payment.ai_tokens).toLocaleString('en-US'))}\n`+
      `📦 <b>الباقة:</b> ${telegramHtml(payment.package_id)}\n`+
      `🧾 <b>معرّف الدفعة:</b> <code>${telegramHtml(paymentId)}</code>\n`+
      `🔗 <b>معرّف المعاملة:</b> <code>${telegramHtml(remoteTx)}</code>\n`+
      `🕒 <b>الوقت:</b> ${telegramHtml(formatCairoDateTime())}`
    );
    return json(res,200,{completed:true,resolved:true,tokens:payment.ai_tokens});
  }catch(error){
    return handleError(error,res,localize(locale,'تعذر إنهاء الدفعة المعلقة عبر Pi. حاول مرة أخرى.','Could not resolve the pending Pi payment. Try again.'),locale);
  }
}
