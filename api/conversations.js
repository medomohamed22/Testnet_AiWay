import {allowMethods,appError,cleanText,createDownloadTicket,db,handleError,json,localize,requestLocale,requireUser,requireAdmin,sendTelegramNotification,telegramHtml,formatCairoDateTime} from './_lib.js';
import {sendPushToUser} from './app-interactions.js';

async function handleSupport(req,res,user,s,locale){
  const mode=String(req.query?.mode||req.body?.mode||'');
  if(!['support','admin_support'].includes(mode))return false;
  const isAdminMode=mode==='admin_support';
  if(isAdminMode)await requireAdmin(user);

  if(req.method==='GET'){
    if(isAdminMode){
      const threadId=String(req.query?.threadId||'');
      if(threadId){
        const {data:thread,error:tErr}=await s.from('support_threads').select('id,user_id,username,status,created_at,updated_at').eq('id',threadId).single();
        if(tErr)throw appError('DATABASE_ERROR',{},tErr);
        const {data:messages,error:mErr}=await s.from('support_messages').select('id,sender_role,message,created_at,read_at').eq('thread_id',threadId).order('created_at',{ascending:true});
        if(mErr)throw appError('DATABASE_ERROR',{},mErr);
        await s.from('support_messages').update({read_at:new Date().toISOString()}).eq('thread_id',threadId).eq('sender_role','user').is('read_at',null);
        return json(res,200,{thread,messages:messages||[]});
      }
      const {data:threads,error}=await s.from('support_threads').select('id,user_id,username,status,created_at,updated_at').order('updated_at',{ascending:false});
      if(error)throw appError('DATABASE_ERROR',{},error);
      const ids=(threads||[]).map(x=>x.id);let unread=[];
      if(ids.length){const {data,error:uErr}=await s.from('support_messages').select('thread_id').in('thread_id',ids).eq('sender_role','user').is('read_at',null);if(uErr)throw appError('DATABASE_ERROR',{},uErr);unread=data||[]}
      const counts=unread.reduce((a,x)=>(a[x.thread_id]=(a[x.thread_id]||0)+1,a),{});
      return json(res,200,{threads:(threads||[]).map(t=>({...t,unread:counts[t.id]||0}))});
    }
    let {data:thread,error:tErr}=await s.from('support_threads').select('id,user_id,username,status,created_at,updated_at').eq('user_id',user.id).maybeSingle();
    if(tErr)throw appError('DATABASE_ERROR',{},tErr);
    if(!thread){const {data,error}=await s.from('support_threads').insert({user_id:user.id,username:user.username||'Pi User'}).select('*').single();if(error)throw appError('DATABASE_ERROR',{},error);thread=data}
    const {data:messages,error:mErr}=await s.from('support_messages').select('id,sender_role,message,created_at,read_at').eq('thread_id',thread.id).order('created_at',{ascending:true});
    if(mErr)throw appError('DATABASE_ERROR',{},mErr);
    const unread=(messages||[]).filter(m=>m.sender_role==='admin'&&!m.read_at).length;
    if(String(req.query?.markRead||'')==='1'&&unread)await s.from('support_messages').update({read_at:new Date().toISOString()}).eq('thread_id',thread.id).eq('sender_role','admin').is('read_at',null);
    return json(res,200,{thread,messages:messages||[],unread});
  }

  if(req.method==='POST'){
    const message=cleanText(req.body?.message,2000);
    if(!message)return json(res,400,{error:localize(locale,'اكتب رسالة الدعم أولًا.','Write a support message first.'),code:'INVALID_REQUEST'});
    if(isAdminMode){
      const threadId=String(req.body?.threadId||'');
      if(!threadId)return json(res,400,{error:localize(locale,'محادثة الدعم مطلوبة.','Support thread is required.'),code:'INVALID_REQUEST'});
      const {data:thread,error:tErr}=await s.from('support_threads').select('id').eq('id',threadId).single();if(tErr)throw appError('DATABASE_ERROR',{},tErr);
      const {data,error}=await s.from('support_messages').insert({thread_id:thread.id,sender_role:'admin',sender_id:user.id,message}).select('*').single();if(error)throw appError('DATABASE_ERROR',{},error);
      await s.from('support_threads').update({status:'open',updated_at:new Date().toISOString()}).eq('id',thread.id);
      const {data:threadOwner}=await s.from('support_threads').select('user_id').eq('id',thread.id).maybeSingle();
      if(threadOwner?.user_id)await sendPushToUser(s,threadOwner.user_id,{title:locale==='en'?'New reply from AiWay support':'رد جديد من دعم AiWay',body:message,url:'/',tag:'aiway-support'});
      return json(res,201,{message:data});
    }
    let {data:thread,error:tErr}=await s.from('support_threads').select('id').eq('user_id',user.id).maybeSingle();if(tErr)throw appError('DATABASE_ERROR',{},tErr);
    if(!thread){const {data,error}=await s.from('support_threads').insert({user_id:user.id,username:user.username||'Pi User'}).select('id').single();if(error)throw appError('DATABASE_ERROR',{},error);thread=data}
    const {data,error}=await s.from('support_messages').insert({thread_id:thread.id,sender_role:'user',sender_id:user.id,message}).select('*').single();if(error)throw appError('DATABASE_ERROR',{},error);
    await s.from('support_threads').update({status:'open',updated_at:new Date().toISOString()}).eq('id',thread.id);
    await sendTelegramNotification(
      `📩 <b>رسالة دعم جديدة</b>\n\n`+
      `👤 <b>اسم المستخدم:</b> ${telegramHtml(user.username||'مستخدم Pi')}\n`+
      `🆔 <b>معرّف المستخدم:</b> <code>${telegramHtml(user.id)}</code>\n`+
      `🕒 <b>الوقت:</b> ${telegramHtml(formatCairoDateTime(data.created_at))}\n\n`+
      `💬 <b>محتوى الرسالة:</b>\n${telegramHtml(message)}`
    );
    return json(res,201,{message:data});
  }
  return json(res,405,{error:'Method not allowed',code:'METHOD_NOT_ALLOWED'});
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST','PATCH','DELETE']))return;
  const locale=requestLocale(req);
  try{
    const user=await requireUser(req),s=db();
    const supportHandled=await handleSupport(req,res,user,s,locale);if(supportHandled!==false)return supportHandled;

    if(req.method==='GET'){
      const id=String(req.query?.id||'');
      if(id){
        const imagesOnly=String(req.query?.imagesOnly||'')==='1';
        const includeImages=String(req.query?.includeImages||'1')!=='0';

        if(imagesOnly){
          const {data:images,error}=await s.from('generated_images').select('*')
            .eq('conversation_id',id).eq('user_id',user.id).order('created_at',{ascending:true});
          if(error)throw appError('DATABASE_ERROR',{},error);
          const hydrated=await Promise.all((images||[]).map(async image=>{
            const output={...image};
            if(output.storage_path||output.thumbnail_data||output.source_url){
              const ticket=await createDownloadTicket({sub:user.id,imageId:output.id,kind:'image-view'},'2h');
              output.display_url=`/api/image?action=view&ticket=${encodeURIComponent(ticket)}`;
            }
            return output;
          }));
          return json(res,200,{images:hydrated});
        }

        const {data:conversation,error:conversationError}=await s.from('conversations')
          .select('*').eq('id',id).eq('user_id',user.id).single();
        if(conversationError)throw appError('DATABASE_ERROR',{},conversationError);

        const {data:messages,error:messagesError}=await s.from('messages')
          .select('*').eq('conversation_id',id).eq('user_id',user.id)
          .order('created_at',{ascending:true});
        if(messagesError)throw appError('DATABASE_ERROR',{},messagesError);

        if(!includeImages){
          conversation.messages=(messages||[]).map(message=>({...message,generated_images:[]}));
          return json(res,200,{conversation});
        }

        const messageIds=(messages||[]).map(message=>message.id);
        let images=[];
        if(messageIds.length){
          const {data,error}=await s.from('generated_images').select('*')
            .eq('conversation_id',id).eq('user_id',user.id)
            .in('message_id',messageIds).order('created_at',{ascending:true});
          if(error)throw appError('DATABASE_ERROR',{},error);
          images=data||[];
        }

        const hydratedImages=await Promise.all(images.map(async image=>{
          const output={...image};
          if(output.storage_path||output.thumbnail_data||output.source_url){
            const ticket=await createDownloadTicket({sub:user.id,imageId:output.id,kind:'image-view'},'2h');
            output.display_url=`/api/image?action=view&ticket=${encodeURIComponent(ticket)}`;
          }
          return output;
        }));
        const imagesByMessage=new Map();
        for(const image of hydratedImages){
          const list=imagesByMessage.get(image.message_id)||[];
          list.push(image);
          imagesByMessage.set(image.message_id,list);
        }

        conversation.messages=(messages||[]).map(message=>({
          ...message,
          generated_images:imagesByMessage.get(message.id)||[]
        }));
        return json(res,200,{conversation});
      }

      const {data,error}=await s.from('conversations')
        .select('id,title,model_id,updated_at,created_at')
        .eq('user_id',user.id).order('updated_at',{ascending:false});
      if(error)throw appError('DATABASE_ERROR',{},error);
      return json(res,200,{conversations:data});
    }

    if(req.method==='POST'){
      const {data,error}=await s.from('conversations').insert({
        user_id:user.id,
        title:cleanText(req.body?.title||'New chat',80),
        model_id:cleanText(req.body?.modelId,120)
      }).select('*').single();
      if(error)throw appError('DATABASE_ERROR',{},error);
      return json(res,201,{conversation:data});
    }

    const id=String(req.body?.id||req.query?.id||'');
    if(!id)return json(res,400,{error:localize(locale,'معرّف المحادثة مطلوب.','Conversation id is required.'),code:'INVALID_REQUEST'});
    if(req.method==='PATCH'){
      const patch={};
      if(req.body?.title!==undefined)patch.title=cleanText(req.body.title,80);
      if(req.body?.modelId!==undefined)patch.model_id=cleanText(req.body.modelId,120);
      const {data,error}=await s.from('conversations').update(patch)
        .eq('id',id).eq('user_id',user.id).select('*').single();
      if(error)throw appError('DATABASE_ERROR',{},error);
      return json(res,200,{conversation:data});
    }

    // Delete any full-resolution files owned by this conversation before removing
    // the database rows. This prevents orphaned objects in Supabase Storage.
    const {data:imageRows,error:imageLookupError}=await s.from('generated_images')
      .select('storage_path').eq('conversation_id',id).eq('user_id',user.id)
      .not('storage_path','is',null);
    if(imageLookupError)throw appError('DATABASE_ERROR',{},imageLookupError);

    const storagePaths=[...new Set((imageRows||[])
      .map(row=>String(row.storage_path||'').trim()).filter(Boolean))];

    // Supabase Storage accepts a list of paths. Chunking keeps large
    // conversations within request-size limits. If removal fails, keep the
    // conversation intact so the user can retry instead of leaving stale rows.
    for(let offset=0;offset<storagePaths.length;offset+=100){
      const batch=storagePaths.slice(offset,offset+100);
      const {error:storageDeleteError}=await s.storage.from('generated-images').remove(batch);
      if(storageDeleteError)throw appError('DATABASE_ERROR',{},storageDeleteError);
    }

    const {data:deletedRows,error}=await s.from('conversations').delete()
      .eq('id',id).eq('user_id',user.id).select('id');
    if(error)throw appError('DATABASE_ERROR',{},error);
    if(!deletedRows?.length)return json(res,404,{error:localize(locale,'المحادثة غير موجودة أو حُذفت بالفعل.','The conversation was not found or was already deleted.'),code:'FILE_NOT_FOUND'});
    return json(res,200,{deleted:true,deletedImages:storagePaths.length});
  }catch(e){
    return handleError(e,res,localize(locale,'تعذر تنفيذ العملية على المحادثة. حاول مرة أخرى.','Could not complete the conversation operation. Try again.'),locale);
  }
}
