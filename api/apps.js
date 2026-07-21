import { allowMethods, db, json, localize, requestLocale } from './_lib.js';

const APP_FIELDS = 'id,name,slug,category,network,short_description,website_url,icon_url,screenshot_urls,rating,ratings_count,views_count,get_clicks_count,is_verified,is_featured,featured_until,developer_name,created_at';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const locale = requestLocale(req);
  try {
    const supabase = db();
    const now = new Date().toISOString();
    // Keep expired promotions visually inactive without blocking reads if cleanup fails.
    supabase.from('apps').update({ is_featured: false }).eq('is_featured', true).lt('featured_until', now).then(()=>{}).catch(()=>{});

    const params = req.query || {};
    const enhanced = Boolean(params.id || params.q || params.network || params.category || params.sort || params.limit || params.cursor);
    let query = supabase.from('apps').select(APP_FIELDS, enhanced ? { count: 'exact' } : undefined).eq('status', 'published');

    if (params.id) query = query.eq('id', params.id).limit(1);
    if (params.network && ['mainnet','testnet'].includes(String(params.network))) query = query.eq('network', params.network);
    if (params.category && params.category !== 'All') query = query.eq('category', String(params.category).slice(0, 50));
    if (params.q) {
      const q = String(params.q).trim().replace(/[,%()]/g, ' ').slice(0, 80);
      if (q) query = query.or(`name.ilike.%${q}%,short_description.ilike.%${q}%,category.ilike.%${q}%`);
    }
    if (params.cursor) query = query.lt('created_at', params.cursor);

    query = query.order('is_featured', { ascending: false }).order('featured_until', { ascending: false, nullsFirst: false });
    const sort = String(params.sort || 'newest');
    if (sort === 'rating') query = query.order('rating', { ascending: false }).order('ratings_count', { ascending: false });
    else if (sort === 'views') query = query.order('views_count', { ascending: false });
    else if (sort === 'clicks') query = query.order('get_clicks_count', { ascending: false });
    else query = query.order('created_at', { ascending: false });

    const limit = enhanced ? Math.min(Math.max(Number(params.limit) || 20, 1), 50) : null;
    if (limit) query = query.limit(limit);
    const { data, error, count } = await query;
    if (error) throw error;

    res.setHeader('Cache-Control', enhanced ? 's-maxage=45, stale-while-revalidate=240' : 's-maxage=60, stale-while-revalidate=300');
    if (!enhanced) return json(res, 200, { apps: data || [] });
    const apps = data || [];
    if (params.id) return json(res, 200, { app: apps[0] || null });
    return json(res, 200, { apps, total: count ?? apps.length, nextCursor: apps.length === limit ? apps[apps.length - 1]?.created_at || null : null });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: localize(locale, 'تعذر تحميل التطبيقات حاليًا.', 'Could not load the apps right now.'), code: 'SERVER_ERROR' });
  }
}
