import { allowMethods, appError, db, handleError, json, localize, requestLocale, requireUser } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const locale = requestLocale(req);
  try {
    const user = await requireUser(req);
    const { data, error } = await db().from('users')
      .select('id,username,role,ai_tokens,trial_messages_remaining,has_purchased,token_expires_at,created_at')
      .eq('id', user.id).single();
    if (error || !data) throw appError('DATABASE_ERROR', {}, error);
    return json(res, 200, { user: data });
  } catch (error) {
    return handleError(error, res, localize(locale, 'تعذر تحميل بيانات الحساب.', 'Could not load the account details.'), locale);
  }
}
