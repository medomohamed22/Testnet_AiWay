import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, packageQuote, getConfiguredPackages, piApiError, requestLocale, requireUser, requestIp, enforceRateLimit } from './_lib.js';

const piHeaders = () => ({ Authorization: `Key ${process.env.PI_SECRET_KEY}`, 'Content-Type': 'application/json' });
async function getPiPayment(paymentId){
  const response=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`,{headers:piHeaders()},20000);
  const data=await response.json().catch(()=>null);
  if(!response.ok) throw piApiError(response.status,data,{operation:'payment'});
  return data;
}
function paymentOwner(remote){return String(remote?.user_uid||remote?.user?.uid||remote?.metadata?.pi_uid||'');}
function paymentPackage(remote){return String(remote?.metadata?.packageId||remote?.metadata?.package_id||'');}
function closeEnough(a,b){const x=Number(a),y=Number(b);return Number.isFinite(x)&&Number.isFinite(y)&&x>0&&Math.abs(x-y)<=Math.max(0.0000001,y*0.025);}
function validateRemote(remote,user,packageId,quote,paymentId,packages,expectedTokens=packages[packageId]?.tokens){
  const pack=packages[packageId];
  if(!remote) throw appError('PAYMENT_MISMATCH');
  const remoteId=String(remote.identifier||remote.payment_id||''); if(remoteId&&remoteId!==String(paymentId)) throw appError('PAYMENT_MISMATCH');
  if(paymentPackage(remote)!==packageId) throw appError('PAYMENT_MISMATCH');
  const owner=paymentOwner(remote); if(owner&&owner!==String(user.pi_uid)) throw appError('PAYMENT_MISMATCH');
  if(Number(remote?.metadata?.usd||pack.usd)!==Number(pack.usd)) throw appError('PAYMENT_MISMATCH');
  if(Number(remote?.metadata?.tokens||expectedTokens)!==Number(expectedTokens)) throw appError('PAYMENT_MISMATCH');
  if(!closeEnough(remote?.amount,quote.amountPi)) throw appError('PAYMENT_MISMATCH');
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST'])) return;
  const locale=requestLocale(req);
  try{
    const user=await requireUser(req);
    await enforceRateLimit(db(),`payment:${user.id}:${requestIp(req)}`,12,60);
    const paymentId=String(req.body?.paymentId||'').trim();
    const requestedPackage=String(req.body?.packageId||'').trim();
    const packages=await getConfiguredPackages();
    if(!paymentId||!packages[requestedPackage]) throw appError('PAYMENT_INVALID');
    if(!process.env.PI_SECRET_KEY) throw appError('MISSING_CONFIGURATION');
    const [remote,quote]=await Promise.all([getPiPayment(paymentId),packageQuote(requestedPackage)]);
    const supabase=db();
    const existing=await supabase.from('payments').select('*').eq('payment_id',paymentId).maybeSingle();
    if(existing.error) throw appError('DATABASE_ERROR',{},existing.error);
    if(existing.data){
      if(existing.data.user_id!==user.id||existing.data.package_id!==requestedPackage) throw appError('PAYMENT_MISMATCH');
      // Preserve approved payments created before a pricing update by validating
      // against the immutable token amount already stored for that payment.
      validateRemote(remote,user,requestedPackage,quote,paymentId,packages,existing.data.ai_tokens);
      return json(res,200,{approved:true,amountPi:Number(existing.data.amount_pi),alreadyApproved:true});
    }
    // Every newly approved payment must use the current package token amount.
    validateRemote(remote,user,requestedPackage,quote,paymentId,packages,packages[requestedPackage].tokens);

    const response=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/approve`,{method:'POST',headers:piHeaders()},20000);
    const data=await response.json().catch(()=>null);
    if(!response.ok) throw piApiError(response.status,data,{operation:'payment'});
    const amountPi=Number(remote.amount);
    const {error}=await supabase.from('payments').insert({user_id:user.id,payment_id:paymentId,package_id:requestedPackage,amount_pi:amountPi,usd_amount:packages[requestedPackage].usd,pi_usd_rate:Number((packages[requestedPackage].usd/amountPi).toFixed(8)),ai_tokens:packages[requestedPackage].tokens,status:'approved',raw_response:{approval:data,payment:remote}});
    if(error){if(/duplicate|unique/i.test(String(error.message||''))) throw appError('PAYMENT_MISMATCH');throw appError('DATABASE_ERROR',{},error);}
    return json(res,200,{approved:true,amountPi});
  }catch(error){return handleError(error,res,localize(locale,'تعذر اعتماد الدفعة عبر Pi. حاول مرة أخرى.','Could not approve the Pi payment. Try again.'),locale);}
}
