import { affordableOutputLimit, allowMethods, appError, chargeTokens, classifyTokenChargeFailure, cleanText, db, errorDetails, estimateChatCharge, fetchWithTimeout, getAvailableModels, getModel, getTrialModelId, handleError, isLowBalance, localize, openRouterError, requestLocale, requireUser, shouldTryModelFallback, ensureConversationOwner, normalizeRequestId, reserveAiTokens, finalizeAiTokens, releaseAiTokens, chooseAutoModel, isFreeModel, claimFreeDailyUse, createDownloadTicket, verifyDownloadTicket } from './_lib.js';

function extractDownloadableFiles(text) {
  const files = [];
  const re = /```file-([^\n`]+)\n([\s\S]*?)```/g;
  let match;
  while ((match = re.exec(String(text || ''))) && files.length < 8) {
    files.push({ name: match[1].trim(), content: match[2].replace(/\n$/, '') });
  }
  return files;
}

function safeDownloadFilename(value) {
  return String(value || 'aiway-file.txt')
    .replace(/[\r\n\0]/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 150) || 'aiway-file.txt';
}

function fileContentType(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const types = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json; charset=utf-8',
    txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
    xml: 'application/xml; charset=utf-8', svg: 'image/svg+xml; charset=utf-8', py: 'text/x-python; charset=utf-8',
    java: 'text/x-java-source; charset=utf-8', c: 'text/x-c; charset=utf-8', cpp: 'text/x-c++; charset=utf-8',
    ts: 'text/typescript; charset=utf-8', tsx: 'text/typescript; charset=utf-8', jsx: 'text/javascript; charset=utf-8',
    sql: 'application/sql; charset=utf-8', yaml: 'application/yaml; charset=utf-8', yml: 'application/yaml; charset=utf-8'
  };
  return types[ext] || 'application/octet-stream';
}


function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function makeStoreZip(files) {
  const local = [], central = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(safeDownloadFilename(file.name), 'utf8');
    const data = Buffer.from(file.content, 'utf8'); const crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50,0); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6); header.writeUInt16LE(0,8); header.writeUInt16LE(0,10); header.writeUInt16LE(0,12); header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(name.length,26);
    local.push(header,name,data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50,0); ch.writeUInt16LE(20,4); ch.writeUInt16LE(20,6); ch.writeUInt16LE(0x800,8); ch.writeUInt16LE(0,10); ch.writeUInt16LE(0,12); ch.writeUInt16LE(0,14); ch.writeUInt32LE(crc,16); ch.writeUInt32LE(data.length,20); ch.writeUInt32LE(data.length,24); ch.writeUInt16LE(name.length,28); ch.writeUInt32LE(offset,42); central.push(ch,name); offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((n,b)=>n+b.length,0); const end=Buffer.alloc(22); end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(offset,16); return Buffer.concat([...local,...central,end]);
}
async function getOwnedAssistantMessage(messageId, userId) {
  const { data: message, error } = await db().from('messages')
    .select('id,content,role').eq('id', messageId).eq('user_id', userId).eq('role', 'assistant').single();
  if (error || !message) throw new Error('FILE_NOT_FOUND');
  return message;
}

async function prepareNativeDownload(req, res) {
  const user = await requireUser(req);
  const messageId = cleanText(req.body?.messageId, 100);
  const kind = req.body?.kind === 'project' ? 'project' : 'file';
  const fileIndex = Number(req.body?.fileIndex ?? 0);
  if (!messageId || (kind === 'file' && (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 7))) throw appError('INVALID_REQUEST');
  const message = await getOwnedAssistantMessage(messageId, user.id);
  const files = extractDownloadableFiles(message.content);
  if (!files.length || (kind === 'file' && !files[fileIndex])) throw new Error('FILE_NOT_FOUND');
  const ticket = await createDownloadTicket({ sub: user.id, messageId, kind, fileIndex }, '2m');
  res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.end(JSON.stringify({ url: `/api/chat?action=native-download&ticket=${encodeURIComponent(ticket)}` }));
}

async function nativeDownload(req, res) {
  const ticket = await verifyDownloadTicket(req.query?.ticket);
  const message = await getOwnedAssistantMessage(String(ticket.messageId), String(ticket.sub));
  const files = extractDownloadableFiles(message.content);
  let body, filename, contentType;
  if (ticket.kind === 'project') {
    if (!files.length) throw new Error('FILE_NOT_FOUND');
    body = makeStoreZip(files); filename = 'aiway-project.zip'; contentType = 'application/zip';
  } else {
    const fileIndex = Number(ticket.fileIndex);
    const file = files[fileIndex]; if (!file) throw new Error('FILE_NOT_FOUND');
    filename = safeDownloadFilename(file.name); body = Buffer.from(file.content, 'utf8'); contentType = fileContentType(filename);
  }
  const asciiName = filename.replace(/[^a-zA-Z0-9._-]/g, '-') || 'aiway-download';
  res.status(200);
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(body);
}

async function downloadGeneratedProject(req,res) {
  const messageId=String(req.query?.messageId||req.body?.messageId||''); if(!messageId) throw new Error('UNAUTHORIZED');
  const user=await requireUser(req);
  const {data:message,error}=await db().from('messages').select('id,content,role').eq('id',messageId).eq('user_id',user.id).eq('role','assistant').single(); if(error||!message) throw new Error('FILE_NOT_FOUND');
  const files=extractDownloadableFiles(message.content); if(!files.length) throw new Error('FILE_NOT_FOUND'); const body=makeStoreZip(files);
  res.status(200); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Length',String(body.length)); res.setHeader('Content-Disposition',`attachment; filename="aiway-project.zip"`); res.setHeader('Cache-Control','private, no-store, max-age=0'); return res.end(body);
}
async function downloadGeneratedFile(req, res) {
  const messageId = String(req.query?.messageId || req.body?.messageId || '');
  const fileIndex = Number(req.query?.fileIndex ?? req.body?.fileIndex);
  if (!messageId || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 7) throw new Error('UNAUTHORIZED');

  const user = await requireUser(req);

  const { data: message, error } = await db().from('messages')
    .select('id,content,role')
    .eq('id', messageId).eq('user_id', user.id).eq('role', 'assistant').single();
  if (error || !message) throw new Error('FILE_NOT_FOUND');

  const file = extractDownloadableFiles(message.content)[fileIndex];
  if (!file) throw new Error('FILE_NOT_FOUND');
  const filename = safeDownloadFilename(file.name);
  const body = Buffer.from(file.content, 'utf8');
  const asciiName = filename.replace(/[^a-zA-Z0-9._-]/g, '-') || 'aiway-file.txt';

  res.status(200);
  res.setHeader('Content-Type', fileContentType(filename));
  res.setHeader('Content-Length', String(body.length));
  res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(body);
}


const detectLanguage = text => /[\u0600-\u06FF]/.test(String(text || '')) ? 'ar' : 'en';
const formatSystemPrompt = (model, language) => `${language === 'ar' ? `أنت نموذج ${model.name || model.id} داخل منصة AiWay. أجب بالعربية الواضحة ما دام آخر طلب للمستخدم بالعربية، وإذا كتب بالإنجليزية فأجب بالإنجليزية.` : `You are ${model.name || model.id} inside the AiWay platform. Reply in English while the user's latest request is in English, and reply in Arabic when it is Arabic.`}
Maintain full continuity with all earlier messages in this conversation. Never ignore relevant context already provided.
Return polished Markdown only. Keep links valid and code syntactically complete. Do not expose partial markup or unfinished code.
For a downloadable code/text file, use a fenced block whose language is file-FILENAME, for example: \`\`\`file-index.html. Put only the complete file contents inside it.
When the user asks for a long code file, prefer a downloadable file block rather than an excessively long inline explanation.
For a PowerPoint, return one fenced pptx-json block containing valid JSON shaped as {"filename":"presentation.pptx","slides":[{"title":"...","bullets":["..."]}]}. Keep slide text concise and valid JSON with no comments.
Use short headings only when useful, fenced code blocks with a language, and tables only for real comparisons.`;

async function readProviderFailure(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}


const AGENT_PLAN_MARKER = 'AIWAY_AGENT_PLAN';

function encodeAgentPlan(plan) {
  return Buffer.from(String(plan || ''), 'utf8').toString('base64url');
}

function extractAgentPlan(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant' || typeof message.content !== 'string') continue;
    const match = message.content.match(/<!--\s*AIWAY_AGENT_PLAN:([A-Za-z0-9_-]+)\s*-->/);
    if (!match) continue;
    try { return Buffer.from(match[1], 'base64url').toString('utf8'); } catch { return ''; }
  }
  return '';
}

function mergeUsage(target, usage) {
  const result = { ...target };
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    result[key] = Math.max(0, Number(result[key] || 0)) + Math.max(0, Number(usage?.[key] || 0));
  }
  result.cost = Math.max(0, Number(result.cost || 0)) + Math.max(0, Number(usage?.cost || 0));
  return result;
}

function parseApprovalDecision(text) {
  const raw = String(text || '').trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return { approved: parsed.approved === true, note: cleanText(parsed.note || '', 500) };
  } catch {
    return { approved: /\btrue\b|موافق|approved|approve/i.test(raw), note: '' };
  }
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  const uiLocale = requestLocale(req);
  let reservationUserId = null, reservationRequestId = null, reservationSupabase = null, reservationActive = false;
  try {
    const downloadAction = String(req.query?.action || req.body?.action || '');
    if (req.method === 'GET' && downloadAction === 'native-download') return await nativeDownload(req, res);
    if (req.method === 'POST' && downloadAction === 'prepare-download') return await prepareNativeDownload(req, res);
    if ((req.method === 'GET' || req.method === 'POST') && downloadAction === 'download-file') return await downloadGeneratedFile(req, res);
    if ((req.method === 'GET' || req.method === 'POST') && downloadAction === 'download-project') return await downloadGeneratedProject(req, res);
    if (req.method !== 'POST') throw appError('INVALID_REQUEST');

    const user = await requireUser(req);
    const { conversationId, modelId, messages, temperature = 0.7, webSearch = false, attachments = [], requestId: rawRequestId, continueFromMessageId: rawContinueFromMessageId, agentMode = false, agentAction = 'plan' } = req.body || {};
    const continueFromMessageId = cleanText(rawContinueFromMessageId, 80);
    const requestId = normalizeRequestId(rawRequestId);
    reservationUserId = user.id; reservationRequestId = requestId;
    if (!conversationId || !modelId || !Array.isArray(messages)) throw appError('INVALID_CHAT_REQUEST');

    const trialModelId = await getTrialModelId();
    let model = modelId === 'aiway/auto' ? null : await getModel(modelId);
    if (modelId !== 'aiway/auto' && !model) throw appError('MODEL_UNAVAILABLE');

    const supabase = db();
    reservationSupabase = supabase;
    await ensureConversationOwner(supabase, conversationId, user.id);
    let continuationTarget = null;
    if (continueFromMessageId) {
      const { data, error } = await supabase.from('messages')
        .select('id,content,model_id,token_usage,created_at')
        .eq('id', continueFromMessageId)
        .eq('conversation_id', conversationId)
        .eq('user_id', user.id)
        .eq('role', 'assistant')
        .single();
      if (error || !data) throw appError('INVALID_CHAT_REQUEST', {}, error);
      const { data: newerMessages, error: newerError } = await supabase.from('messages')
        .select('id').eq('conversation_id', conversationId).eq('user_id', user.id)
        .gt('created_at', data.created_at).limit(1);
      if (newerError) throw appError('DATABASE_ERROR', {}, newerError);
      if (newerMessages?.length) throw appError('INVALID_CHAT_REQUEST');
      continuationTarget = data;
    }
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('ai_tokens,trial_messages_remaining,has_purchased')
      .eq('id', user.id)
      .single();
    if (profileError || !profile) throw appError('DATABASE_ERROR', {}, profileError);

    const purchased = Boolean(profile.has_purchased);
    const availableTokens = Math.max(0, Number(profile.ai_tokens || 0));
    if (!purchased && modelId !== trialModelId && modelId !== 'aiway/auto' && !isFreeModel(model)) throw appError('MODEL_LOCKED');
    if (!purchased && webSearch) throw appError('TRIAL_WEB_LOCKED');
    if (!purchased && Number(profile.trial_messages_remaining) <= 0) throw appError('TRIAL_ENDED');
    if (availableTokens < 1) throw appError('INSUFFICIENT_TOKENS', { availableTokens });

    const cleaned = messages.slice(-40)
      .map(message => ({
        role: ['system', 'user', 'assistant'].includes(message.role) ? message.role : 'user',
        content: cleanText(message.content, 30000)
      }))
      .filter(message => message.content);

    if (continuationTarget) {
      const continuationInstruction = localize(uiLocale,
        'أكمل الإجابة السابقة مباشرة من حيث توقفت. لا تكرر أي جزء مكتوب، ولا تبدأ بمقدمة جديدة، وحافظ على نفس اللغة والأسلوب والتنسيق.',
        'Continue the previous answer directly from where it stopped. Do not repeat any existing text, do not add a new introduction, and keep the same language, style, and formatting.');
      cleaned.push({ role: 'user', content: continuationInstruction });
    }

    const sourceAttachments = Array.isArray(attachments) ? attachments.slice(0, 3) : [];
    const invalidAttachment = sourceAttachments.some(a => !a || typeof a.name !== 'string' || typeof a.type !== 'string' || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith('data:'));
    if (invalidAttachment) throw appError('INVALID_ATTACHMENT');
    if (sourceAttachments.some(a => a.dataUrl.length > 4_300_000)) throw appError('ATTACHMENT_TOO_LARGE');
    const safeAttachments = sourceAttachments.filter(a => a.dataUrl.length <= 4_300_000);

    if (safeAttachments.length) {
      const lastIndex = [...cleaned].map(x => x.role).lastIndexOf('user');
      if (lastIndex >= 0) {
        const text = cleaned[lastIndex].content || localize(uiLocale, 'حلل الملفات المرفقة', 'Analyze the attached files');
        cleaned[lastIndex].content = [
          { type: 'text', text },
          ...safeAttachments.map(a => a.type.startsWith('image/')
            ? { type: 'image_url', image_url: { url: a.dataUrl } }
            : { type: 'file', file: { filename: cleanText(a.name, 150), file_data: a.dataUrl } })
        ];
      }
    }

    const latestUserText = [...cleaned].reverse().find(m => m.role === 'user')?.content;
    const latestTextValue = typeof latestUserText === 'string' ? latestUserText : latestUserText?.find?.(part => part.type === 'text')?.text || '';
    const autoSelected = modelId === 'aiway/auto';
    if (autoSelected) model = await chooseAutoModel(latestTextValue, { webSearch, hasAttachments: safeAttachments.length > 0 });
    if (!model) throw appError('MODEL_UNAVAILABLE');
    if (isFreeModel(model)) await claimFreeDailyUse(supabase, user.id, 'chat');
    const language = detectLanguage(latestTextValue);
    const safeMessages = [{ role: 'system', content: formatSystemPrompt(model, language) }, ...cleaned.filter(message => message.role !== 'system')];

    const initialEstimate = estimateChatCharge(model.pricing, safeMessages, webSearch, 512);
    if (availableTokens < initialEstimate.chargedTokens) {
      throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
        availableTokens,
        requiredTokens: initialEstimate.chargedTokens,
        shortfall: initialEstimate.chargedTokens - availableTokens
      });
    }

    const initialMaxTokens = affordableOutputLimit(model.pricing, availableTokens, initialEstimate);
    if (initialMaxTokens < 128) {
      throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
        availableTokens,
        requiredTokens: initialEstimate.chargedTokens,
        shortfall: Math.max(1, initialEstimate.chargedTokens - availableTokens)
      });
    }

    if (!process.env.OPENROUTER_API_KEY) throw appError('MISSING_CONFIGURATION');

    // Reserve the full currently available balance before calling the provider.
    // The unused difference is returned atomically after the real usage is known.
    await reserveAiTokens(supabase, user.id, requestId, 'chat', availableTokens);
    reservationActive = true;

    const lastUserMessage = continuationTarget ? null : [...cleaned].reverse().find(message => message.role === 'user');
    if (lastUserMessage) {
      const { error } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'user',
        content: typeof lastUserMessage.content === 'string'
          ? lastUserMessage.content
          : cleanText(lastUserMessage.content?.find?.(part => part.type === 'text')?.text || localize(uiLocale, 'رسالة مع مرفقات', 'Message with attachments'), 30000),
        token_usage: { attachments: safeAttachments.map(a => ({ name: cleanText(a.name, 150), type: a.type, size: Number(a.size || 0) })) }
      });
      if (error) throw appError('DATABASE_ERROR', {}, error);
    }

    if (agentMode === true && !continuationTarget) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');

      const emitStage = (stage, labelAr, labelEn) => res.write(`data: ${JSON.stringify({
        type: 'agent-stage', stage, label: localize(uiLocale, labelAr, labelEn)
      })}\n\n`);
      const emitText = text => {
        const chunks = String(text || '').match(/[\s\S]{1,700}/g) || [];
        for (const chunk of chunks) res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
      };
      const callAgent = async ({ role, instruction, context, maxTokens = 1800, temperature: agentTemperature = 0.2 }) => {
        const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`,
            'X-OpenRouter-Title': 'AiWay Multi-Agent Mode',
            'X-OpenRouter-Metadata': 'enabled'
          },
          body: JSON.stringify({
            model: model.id,
            messages: [
              { role: 'system', content: `${formatSystemPrompt(model, language)}\n\nYou are the ${role} in a controlled multi-agent workflow. The user's request may be about programming, study, training, planning, writing, research, analysis, or any other legitimate task. Complete only your assigned stage and return a polished, finished response for that stage.` },
              { role: 'user', content: `${instruction}\n\nCONTEXT:\n${cleanText(context, 60000)}` }
            ],
            temperature: agentTemperature,
            max_tokens: Math.max(64, Math.floor(maxTokens)),
            stream: false,
            user: user.id
          })
        }, 90000);
        if (!response.ok) throw openRouterError(response.status, await readProviderFailure(response), { kind: 'chat' });
        const payload = await response.json().catch(() => null);
        if (payload?.error) throw openRouterError(Number(payload.error?.code || 502), payload, { kind: 'chat' });
        const content = payload?.choices?.[0]?.message?.content;
        if (!String(content || '').trim()) throw appError('EMPTY_RESPONSE');
        return { content: String(content).trim(), usage: payload?.usage || {}, generationId: payload?.id || null, routedModelId: payload?.model || model.id };
      };

      let workflowUsage = {};
      let answer = '';
      let agentStep = cleanText(agentAction, 20).toLowerCase();
      let generationId = null;
      const pendingPlan = extractAgentPlan(cleaned);
      const assistantMessages = cleaned.filter(m => m.role === 'assistant' && typeof m.content === 'string');
      const latestExecutionOutput = [...assistantMessages].reverse().find(m => /AIWAY_AGENT_EXECUTION/.test(m.content))?.content
        ?.replace(/<!--\s*AIWAY_AGENT_EXECUTION\s*-->/g, '').trim() || '';
      const originalRequests = cleaned.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : '').join('\n\n');

      if (!['plan', 'code', 'review'].includes(agentStep)) agentStep = 'plan';
      if (agentStep === 'plan') {
        emitStage('planning', 'عدة وكلاء يحللون الطلب ويجهزون الخطة', 'Multiple agents are analyzing the request and preparing the plan');
        const planner = await callAgent({
          role: 'planning and strategy agent', maxTokens: 2200,
          instruction: language === 'ar'
            ? 'حلّل طلب المستخدم مهما كان نوعه. أنشئ خطة عملية ومكتملة تشمل الهدف، المدخلات المطلوبة، خطوات التنفيذ، المخرجات المتوقعة، المخاطر أو النواقص، ومعايير النجاح. لا تنفذ المهمة الآن ولا تدّع التنفيذ.'
            : 'Analyze the user request regardless of its type. Produce a complete practical plan covering the goal, required inputs, execution steps, expected outputs, risks or gaps, and success criteria. Do not execute the task or claim completion yet.',
          context: latestTextValue
        });
        workflowUsage = mergeUsage(workflowUsage, planner.usage); generationId = planner.generationId;
        answer = language === 'ar'
          ? `## خطة وكيل التخطيط\n\n${planner.content}\n\n<!-- ${AGENT_PLAN_MARKER}:${encodeAgentPlan(planner.content)} -->`
          : `## Planning agent result\n\n${planner.content}\n\n<!-- ${AGENT_PLAN_MARKER}:${encodeAgentPlan(planner.content)} -->`;
      } else if (agentStep === 'code') {
        if (!pendingPlan) throw appError('INVALID_CHAT_REQUEST');
        emitStage('executing', 'وكيل التنفيذ يطبق الخطة ويجهز النتيجة', 'The execution agent is applying the plan and preparing the result');
        const coder = await callAgent({
          role: 'senior execution agent', maxTokens: Math.min(7500, Math.max(2200, initialMaxTokens)), temperature: 0.18,
          instruction: language === 'ar'
            ? 'نفّذ الخطة المعتمدة كاملة وفق نوع طلب المستخدم. إذا كان الطلب برمجيًا فاكتب كودًا صالحًا للتشغيل وضع كل ملف كامل داخل كتلة file-FILENAME. وإذا كان دراسة أو تدريبًا أو كتابة أو تحليلًا فأنتج المحتوى النهائي الكامل القابل للاستخدام. لا تختصر النتيجة ولا تدّع تنفيذ اختبارات أو إجراءات لم تحدث.'
            : 'Execute the approved plan completely according to the request type. For programming tasks, write runnable code and put every complete file in a file-FILENAME fenced block. For study, training, writing, analysis, or other tasks, produce the complete final usable deliverable. Do not omit essential content or claim tests or actions that were not actually performed.',
          context: `APPROVED PLAN:\n${pendingPlan}\n\nORIGINAL REQUESTS:\n${originalRequests}`
        });
        workflowUsage = mergeUsage(workflowUsage, coder.usage); generationId = coder.generationId;
        answer = language === 'ar'
          ? `## نتيجة وكيل التنفيذ\n\n${coder.content}\n\n<!-- AIWAY_AGENT_EXECUTION -->`
          : `## Execution agent result\n\n${coder.content}\n\n<!-- AIWAY_AGENT_EXECUTION -->`;
      } else {
        if (!pendingPlan || !latestExecutionOutput) throw appError('INVALID_CHAT_REQUEST');
        emitStage('reviewing', 'وكيل المراجعة يفحص النتيجة ويصحح أي مشكلة', 'The review agent is checking the result and correcting any issue');
        const reviewer = await callAgent({
          role: 'senior quality review and correction agent', maxTokens: Math.min(8000, Math.max(2400, initialMaxTokens)), temperature: 0.1,
          instruction: language === 'ar'
            ? 'راجع نتيجة التنفيذ مقابل الخطة وطلب المستخدم. اكتشف أي خطأ أو نقص أو تناقض أو مشكلة جودة وصححه مباشرة. أعد النسخة النهائية الكاملة الجاهزة للاستخدام، مع ملخص قصير لما تم إصلاحه. إذا كانت النتيجة كودًا فأعد كل الملفات المصححة كاملة.'
            : 'Review the execution result against the plan and user request. Find and directly fix any error, omission, inconsistency, or quality issue. Return the complete final usable version with a short summary of corrections. If the result is code, return every corrected file in full.',
          context: `PLAN:\n${pendingPlan}\n\nRESULT TO REVIEW:\n${latestExecutionOutput}`
        });
        workflowUsage = mergeUsage(workflowUsage, reviewer.usage); generationId = reviewer.generationId;
        answer = language === 'ar' ? `## نتيجة وكيل المراجعة\n\n${reviewer.content}` : `## Review agent result\n\n${reviewer.content}`;
      }

      emitText(answer);
      const charge = chargeTokens(model.pricing, workflowUsage, false);
      if (charge.chargedTokens > availableTokens) throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', { availableTokens, requiredTokens: charge.chargedTokens, shortfall: charge.chargedTokens - availableTokens });
      const result = await supabase.from('messages').insert({
        conversation_id: conversationId, user_id: user.id, role: 'assistant', content: answer, model_id: model.id,
        token_usage: { ...workflowUsage, ...charge, requestedModelId: modelId, activeModelId: model.id, routedModelId: model.id, agentWorkflow: true, agentStep, generationIds: generationId ? [generationId] : [] }
      }).select('id').single();
      if (result.error || !result.data) throw appError('DATABASE_ERROR', {}, result.error);
      const remainingTokens = await finalizeAiTokens(supabase, user.id, requestId, charge.chargedTokens, { messageId: result.data.id, modelId: model.id, generationId });
      reservationActive = false;
      await supabase.from('conversations').update({ model_id: model.id, updated_at: new Date().toISOString() }).eq('id', conversationId).eq('user_id', user.id);
      res.write(`data: ${JSON.stringify({ type: 'done', usage: workflowUsage, chargedTokens: charge.chargedTokens, remainingTokens,
        lowBalance: isLowBalance(remainingTokens, charge.chargedTokens), requestedModelId: modelId, routedModelId: model.id,
        activeModelId: model.id, messageId: result.data.id, agentWorkflow: true, agentStep })}\n\n`);
      return res.end();
    }

    const requestOpenRouter = (selectedModelId, maxTokens) => fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host || 'localhost'}`,
        'X-OpenRouter-Title': 'AiWay',
        'X-OpenRouter-Metadata': 'enabled'
      },
      body: JSON.stringify({
        model: selectedModelId,
        messages: safeMessages,
        temperature: Number(temperature),
        max_tokens: Math.max(128, Math.floor(maxTokens)),
        stream: true,
        plugins: [
          webSearch ? { id: 'web' } : null,
          safeAttachments.some(a => a.type === 'application/pdf') ? { id: 'file-parser', pdf: { engine: 'cloudflare-ai' } } : null
        ].filter(Boolean),
        user: user.id
      })
    }, 60000);

    let activeModel = model;
    let activeModelId = model.id;
    let fallbackUsed = false;
    let response = await requestOpenRouter(activeModelId, initialMaxTokens);

    if (!response.ok) {
      let providerError = openRouterError(response.status, await readProviderFailure(response), { kind: 'chat' });
      if (purchased && shouldTryModelFallback(providerError)) {
        const catalog = await getAvailableModels();
        const fallback = catalog.find(candidate => candidate.id !== modelId && candidate.family === model.family)
          || catalog.find(candidate => candidate.id !== modelId);
        if (fallback) {
          const fallbackEstimate = estimateChatCharge(fallback.pricing, safeMessages, webSearch, 512);
          if (availableTokens < fallbackEstimate.chargedTokens) {
            throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
              availableTokens,
              requiredTokens: fallbackEstimate.chargedTokens,
              shortfall: fallbackEstimate.chargedTokens - availableTokens
            });
          }
          const fallbackMaxTokens = affordableOutputLimit(fallback.pricing, availableTokens, fallbackEstimate);
          if (fallbackMaxTokens >= 128) {
            activeModel = fallback;
            activeModelId = fallback.id;
            response = await requestOpenRouter(activeModelId, fallbackMaxTokens);
            fallbackUsed = response.ok;
            if (!response.ok) providerError = openRouterError(response.status, await readProviderFailure(response), { kind: 'chat' });
          }
        }
      }
      if (!response.ok) throw providerError;
    }

    if (!response.body) throw appError('STREAM_INTERRUPTED');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');

    let answer = '';
    let usage = {};
    let generationId = response.headers.get('x-generation-id') || '';
    let routedModelId = '';
    let routerMetadata = null;
    let routeMismatch = null;
    let streamError = null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const event = JSON.parse(raw);
          if (event.error) {
            streamError = openRouterError(Number(event.error?.status || event.error?.code || 502), event, { kind: 'chat' });
            continue;
          }
          if (event.id && !generationId) generationId = event.id;
          if (event.model) routedModelId = event.model;
          if (event.openrouter_metadata) routerMetadata = event.openrouter_metadata;
          if (routedModelId && routedModelId !== activeModelId) routeMismatch = { requested: activeModelId, routed: routedModelId };
          const text = event.choices?.[0]?.delta?.content || '';
          if (text && !routeMismatch && !streamError) {
            answer += text;
            res.write(`data: ${JSON.stringify({ type: 'delta', text })}\n\n`);
          }
          if (event.usage) usage = event.usage;
          if (event.choices?.[0]?.finish_reason === 'error') streamError = appError('PROVIDER_ERROR');
        } catch {
          // Ignore malformed provider heartbeat lines without exposing them to the user.
        }
      }
      if (streamError) break;
    }

    if (streamError) throw streamError;
    if (routeMismatch) throw appError('MODEL_ROUTE_MISMATCH', { requestedModelId: routeMismatch.requested, routedModelId: routeMismatch.routed });
    if (!answer.trim()) throw appError('EMPTY_RESPONSE');

    const charge = chargeTokens(activeModel.pricing, usage, webSearch);
    if (charge.chargedTokens > availableTokens) {
      throw appError('INSUFFICIENT_TOKENS_FOR_REQUEST', {
        availableTokens,
        requiredTokens: charge.chargedTokens,
        shortfall: charge.chargedTokens - availableTokens
      });
    }

    const previousUsage = continuationTarget?.token_usage && typeof continuationTarget.token_usage === 'object' ? continuationTarget.token_usage : {};
    const previousChargedTokens = Math.max(0, Number(previousUsage.chargedTokens || 0));
    const continuationCount = Math.max(0, Number(previousUsage.continuations || 0)) + (continuationTarget ? 1 : 0);
    const savedTokenUsage = {
      ...previousUsage,
      ...usage,
      ...charge,
      chargedTokens: previousChargedTokens + charge.chargedTokens,
      lastContinuationChargedTokens: continuationTarget ? charge.chargedTokens : undefined,
      continuations: continuationCount,
      requestedModelId: modelId,
      autoSelected,
      activeModelId,
      fallbackUsed,
      routedModelId: routedModelId || activeModelId,
      generationId: generationId || null,
      routerMetadata,
      webSearch: Boolean(webSearch)
    };
    let savedAssistant;
    let saveAssistantError;
    if (continuationTarget) {
      const combinedContent = `${String(continuationTarget.content || '').replace(/\s+$/, '')}\n\n${answer.trim()}`;
      const result = await supabase.from('messages').update({
        content: combinedContent,
        model_id: activeModelId,
        token_usage: savedTokenUsage
      }).eq('id', continuationTarget.id).eq('conversation_id', conversationId).eq('user_id', user.id).select('id').single();
      savedAssistant = result.data;
      saveAssistantError = result.error;
    } else {
      const result = await supabase.from('messages').insert({
        conversation_id: conversationId,
        user_id: user.id,
        role: 'assistant',
        content: answer,
        model_id: activeModelId,
        token_usage: savedTokenUsage
      }).select('id').single();
      savedAssistant = result.data;
      saveAssistantError = result.error;
    }
    if (saveAssistantError || !savedAssistant) throw appError('DATABASE_ERROR', {}, saveAssistantError);

    const remainingTokens = await finalizeAiTokens(supabase, user.id, requestId, charge.chargedTokens, {
      messageId: savedAssistant.id, modelId: activeModelId, generationId: generationId || null
    });
    reservationActive = false;
    const conversationUpdate = await supabase.from('conversations')
      .update({ model_id: activeModelId, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .eq('user_id', user.id);
    if (conversationUpdate.error) console.warn('Conversation timestamp update failed:', conversationUpdate.error.message);

    res.write(`data: ${JSON.stringify({
      type: 'done',
      usage,
      chargedTokens: charge.chargedTokens,
      remainingTokens,
      lowBalance: isLowBalance(remainingTokens, charge.chargedTokens),
      requestedModelId: modelId,
        autoSelected,
      routedModelId: routedModelId || activeModelId,
      fallbackUsed,
      activeModelId,
      generationId: generationId || null,
      messageId: savedAssistant.id,
      continuation: Boolean(continuationTarget),
      continuations: continuationCount,
      totalChargedTokens: previousChargedTokens + charge.chargedTokens
    })}\n\n`);
    return res.end();
  } catch (error) {
    if (reservationActive && reservationSupabase && reservationUserId && reservationRequestId) {
      await releaseAiTokens(reservationSupabase, reservationUserId, reservationRequestId, { code: String(error?.code || 'SERVER_ERROR') });
      reservationActive = false;
    }
    if (res.headersSent) {
      const details = errorDetails(error, uiLocale);
      res.write(`data: ${JSON.stringify({
        type: 'error',
        error: details?.message || localize(uiLocale, 'حدث عطل مؤقت. حاول مرة أخرى؛ لم يتم خصم رصيدك.', 'A temporary error occurred. Try again; your balance was not charged.'),
        code: details?.code || 'SERVER_ERROR',
        ...(details?.meta || {})
      })}\n\n`);
      return res.end();
    }
    return handleError(
      error,
      res,
      localize(uiLocale, 'حدث عطل مؤقت أثناء معالجة الرسالة. حاول مرة أخرى؛ لم يتم خصم رصيدك.', 'A temporary error occurred while processing the message. Try again; your balance was not charged.'),
      uiLocale
    );
  }
}
