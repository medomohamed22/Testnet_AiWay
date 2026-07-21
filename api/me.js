import { allowMethods, appError, db, handleError, json, localize, requestLocale, requireUser } from './_lib.js';

function buildUsage(rows = []) {
  const modelMap = new Map();
  const history = [];
  let totalUsed = 0;

  for (const row of rows) {
    const tokens = Math.max(0, Number(row.charged_tokens || 0));
    if (!tokens) continue;
    const modelId = String(row.response_meta?.modelId || 'AI');
    totalUsed += tokens;
    const current = modelMap.get(modelId) || { modelId, tokens: 0, requests: 0 };
    current.tokens += tokens;
    current.requests += 1;
    modelMap.set(modelId, current);
    history.push({
      id: row.id,
      modelId,
      kind: row.kind,
      tokens,
      createdAt: row.created_at,
      completedAt: row.completed_at
    });
  }

  return {
    totalUsed,
    totalRequests: history.length,
    models: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
    history
  };
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const locale = requestLocale(req);
  try {
    const user = await requireUser(req);
    const supabase = db();
    const { data, error } = await supabase.from('users')
      .select('id,username,role,ai_tokens,trial_messages_remaining,has_purchased,token_expires_at,created_at')
      .eq('id', user.id).single();
    if (error || !data) throw appError('DATABASE_ERROR', {}, error);

    const usageResult = await supabase.from('ai_usage_reservations')
      .select('id,kind,charged_tokens,response_meta,created_at,completed_at')
      .eq('user_id', user.id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(500);

    const usage = usageResult.error ? buildUsage([]) : buildUsage(usageResult.data || []);
    return json(res, 200, { user: data, usage });
  } catch (error) {
    return handleError(error, res, localize(locale, 'تعذر تحميل بيانات الحساب.', 'Could not load the account details.'), locale);
  }
}
