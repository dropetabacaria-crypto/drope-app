// Drope — Admin List Pending (FLC FASE 5)
// GET /api/admin-list-pending?token=ADMIN_TOKEN
// Lista produtos com status='pending' (cadastrados via lote, aguardando aprovacao).
// Retorna box_photo_url + reference_image_url + image_url pra exibir lado a lado.

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  const headerTok = req.headers['x-admin-token'] || '';
  let queryTok = '';
  try {
    const qs = (req.url || '').split('?')[1] || '';
    const m = qs.split('&').find(x => x.startsWith('token='));
    if (m) queryTok = decodeURIComponent(m.slice(6));
  } catch (e) {}
  if (headerTok !== ADMIN_TOKEN && queryTok !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    const fields = 'id,slug,name,price_cents,cost_price,qty_available,box_photo_url,reference_image_url,image_url,image_status,metadata,puffs,battery,liquid_ml,nicotine,description,flavor_sweet,flavor_ice,flavor_sour,status,created_at';
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?select=${fields}&status=eq.pending&order=created_at.desc&limit=500`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });
    // Agrupa por modelo (brand+model) pra UI mostrar agrupado
    const groups = {};
    for (const p of rows) {
      const meta = p.metadata || {};
      const brand = meta.brand || '?';
      const model = meta.model || '';
      const key = `${brand} ${model}`.trim();
      if (!groups[key]) groups[key] = { brand, model, products: [] };
      groups[key].products.push(p);
    }
    return res.status(200).json({
      ok: true,
      total: Array.isArray(rows) ? rows.length : 0,
      products: rows,
      grouped: Object.values(groups),
    });
  } catch (err) {
    console.error('[admin-list-pending] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
