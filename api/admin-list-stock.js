// Drope — Admin List Stock (lista TODOS produtos, incluindo hidden)
// GET /api/admin-list-stock
// Header: x-admin-token: <ADMIN_TOKEN>
//
// Diferenca pro /api/check-stock: este retorna inclusive os produtos hidden=true
// (cadastrados pelo agente whats antes do preco ser definido). Necessario pro /admin
// poder definir preco e despublicar o hidden.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN

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
  // OSSO 29 — aceita token via header (legacy) OU query string ?token= (admin_hub)
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
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?select=id,slug,name,price_cents,qty_available,category,badge,image_url,image_status,hidden,descricao_quebrada,cores_predominantes,created_via,metadata,barcode,created_at,ref_status,reference_image_url,box_photo_url&order=created_at.desc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });
    return res.status(200).json({ ok: true, products: rows, count: Array.isArray(rows) ? rows.length : 0 });
  } catch (err) {
    console.error('[admin-list-stock] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
