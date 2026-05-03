// Drope — Admin Update Stock (atualiza estoque do produto)
// POST /api/admin-update-stock
// Header: x-admin-token: <ADMIN_TOKEN>
// Body: { slug: string, qty_available?: number, hidden?: boolean, price_cents?: number, badge?: string }
//   pelo menos UM dos campos opcionais precisa vir.
//
// Outras operações:
//   POST /api/admin-update-stock?action=create
//   Body: { slug, name, category, price_cents, qty_available, badge?, image_url? }
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";

module.exports = async function handler(req, res) {
  // CORS
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // 🔒 AUTH
  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  const provided = req.headers['x-admin-token'] || '';
  if (provided !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  const action = req.query?.action || 'update';

  try {
    const body = req.body || {};
    const { slug, name, category, price_cents, qty_available, hidden, badge, image_url, barcode, created_via } = body;

    // 🔒 Validação básica do slug em todas as ações
    if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) {
      return res.status(400).json({ error: 'invalid slug (only a-z, 0-9, -, max 80 chars)' });
    }

    // ---- CREATE ----
    if (action === 'create') {
      if (!name || typeof name !== 'string' || name.length > 200) return res.status(400).json({ error: 'invalid name' });
      if (typeof price_cents !== 'number' || price_cents < 0 || price_cents > 10000000) return res.status(400).json({ error: 'invalid price_cents' });
      if (qty_available !== undefined && (typeof qty_available !== 'number' || qty_available < 0 || qty_available > 100000)) return res.status(400).json({ error: 'invalid qty_available' });
      if (category && (typeof category !== 'string' || category.length > 50)) return res.status(400).json({ error: 'invalid category' });

      const row = {
        slug,
        name: name.slice(0, 200),
        category: category || null,
        price_cents,
        qty_available: qty_available || 0,
        badge: badge ? String(badge).slice(0, 50) : null,
        image_url: image_url ? String(image_url).slice(0, 500) : null,
        barcode: barcode ? String(barcode).replace(/\D/g, '').slice(0, 20) : null,
        hidden: hidden === true ? true : false,
        created_via: created_via ? String(created_via).slice(0, 30) : 'admin',
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_products`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(row),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'create failed', details: data });
      return res.status(200).json({ ok: true, product: Array.isArray(data) ? data[0] : data });
    }

    // ---- UPDATE ----
    const updates = {};
    if (qty_available !== undefined) {
      if (typeof qty_available !== 'number' || qty_available < 0 || qty_available > 100000) return res.status(400).json({ error: 'invalid qty_available' });
      updates.qty_available = qty_available;
    }
    if (hidden !== undefined) {
      if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'invalid hidden' });
      updates.hidden = hidden;
    }
    if (price_cents !== undefined) {
      if (typeof price_cents !== 'number' || price_cents < 0 || price_cents > 10000000) return res.status(400).json({ error: 'invalid price_cents' });
      updates.price_cents = price_cents;
    }
    if (badge !== undefined) {
      if (badge !== null && (typeof badge !== 'string' || badge.length > 50)) return res.status(400).json({ error: 'invalid badge' });
      updates.badge = badge;
    }
    if (name !== undefined) {
      if (typeof name !== 'string' || name.length > 200) return res.status(400).json({ error: 'invalid name' });
      updates.name = name;
    }
    if (barcode !== undefined) {
      if (barcode !== null && (typeof barcode !== 'string' || !/^[0-9]{0,20}$/.test(barcode))) return res.status(400).json({ error: 'invalid barcode (digits only, max 20)' });
      updates.barcode = barcode ? barcode.slice(0, 20) : null;
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no updates provided' });
    }

    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}`,
      {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(updates),
      }
    );
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'update failed', details: data });
    if (!Array.isArray(data) || data.length === 0) return res.status(404).json({ error: 'product not found' });

    return res.status(200).json({ ok: true, product: data[0], updates });

  } catch (err) {
    console.error('[admin-update-stock] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
