// Drope — Admin Orders (lista pedidos com filtros)
// Endpoint protegido GET /api/admin-orders
// Header obrigatório: x-admin-token: <ADMIN_TOKEN env var>
//
// Query params:
//   ?status=created,paid,preparing,out_for_delivery,delivered,picked_up,cancelled
//   ?limit=50 (max 200)
//   ?since=YYYY-MM-DD (default: hoje 00h)
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";

module.exports = async function handler(req, res) {
  // CORS — admin tb usa drope-app.vercel.app (mesma origin)
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // 🔒 AUTH
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
    // Pequeno delay pra dificultar timing attack / brute force
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query?.limit || '50', 10) || 50));

    // Default: pedidos desde 00h de hoje (timezone São Paulo)
    let since = req.query?.since || '';
    if (!since) {
      const now = new Date();
      const sp = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
      sp.setHours(0, 0, 0, 0);
      since = sp.toISOString();
    }

    // Filtro de status (opcional, vírgula-separado)
    const statusParam = req.query?.status || '';
    let statusFilter = '';
    if (statusParam) {
      const list = String(statusParam).split(',').map(s => s.trim()).filter(s => /^[a-z_]{1,30}$/.test(s));
      if (list.length > 0) {
        statusFilter = `&status=in.(${list.map(s => `"${s}"`).join(',')})`;
      }
    }

    const url = `${SUPABASE_URL}/rest/v1/drope_orders?created_at=gte.${encodeURIComponent(since)}${statusFilter}&order=created_at.desc&limit=${limit}&select=id,order_nsu,status,payment_method,total_cents,subtotal_cents,delivery_fee_cents,delivery_mode,address,items,customer_snapshot,customer_id,transaction_id,created_at,payment_confirmed_at,prepared_at,dispatched_at,delivered_at,picked_up_at,customer_track_token,status_history`;

    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });

    // Stats rápidos
    const stats = {
      total: rows.length,
      pending: rows.filter(o => ['created', 'paid', 'preparing', 'out_for_delivery', 'ready_for_pickup'].includes(o.status)).length,
      done: rows.filter(o => ['delivered', 'picked_up'].includes(o.status)).length,
      cancelled: rows.filter(o => o.status === 'cancelled').length,
      revenue_cents: rows.filter(o => ['paid', 'preparing', 'out_for_delivery', 'ready_for_pickup', 'delivered', 'picked_up'].includes(o.status))
        .reduce((sum, o) => sum + (o.total_cents || 0), 0),
    };

    return res.status(200).json({ ok: true, orders: rows, stats, since, limit });

  } catch (err) {
    console.error('[admin-orders] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
