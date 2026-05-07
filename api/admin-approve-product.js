// Drope — Admin Approve Product (FLC FASE 5)
// POST /api/admin-approve-product
// Body: { id, action, price_cents?, cost_price? }
// action: 'approve' | 'reject' | 'regenerate_art' | 'set_price' | 'approve_all'
// Header: x-admin-token: ADMIN_TOKEN (ou ?token=)

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";

async function _sbUpdate(filter, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_products?${filter}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(data),
  });
  return r;
}

async function _fireArt(productId, attempt = 1) {
  if (!ADMIN_TOKEN) return;
  const host = process.env.VERCEL_URL || 'drope-app.vercel.app';
  const url = `https://${host}/api/webhook?action=generate_art&product_id=${encodeURIComponent(productId)}&phone=admin&attempt=${attempt}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
      signal: controller.signal,
    });
  } catch (_) { /* expected abort */ } finally { clearTimeout(t); }
}

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

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

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  const { id, action, price_cents, cost_price, ids } = body || {};

  try {
    if (action === 'approve_all') {
      // Aprova em massa: setar status='active' + hidden=false em todos os pending.
      const r = await _sbUpdate('status=eq.pending', {
        status: 'active', hidden: false, updated_at: new Date().toISOString(),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'sb error', details: data });
      return res.status(200).json({ ok: true, action: 'approve_all', updated: Array.isArray(data) ? data.length : 0 });
    }

    if (!id) return res.status(400).json({ error: 'missing id' });

    if (action === 'approve') {
      const update = {
        status: 'active',
        hidden: false,
        updated_at: new Date().toISOString(),
      };
      if (typeof price_cents === 'number' && price_cents > 0) update.price_cents = price_cents;
      if (typeof cost_price === 'number' && cost_price > 0) update.cost_price = cost_price;
      const r = await _sbUpdate(`id=eq.${id}`, update);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'sb error', details: data });
      return res.status(200).json({ ok: true, action: 'approve', product: data[0] || null });
    }

    if (action === 'set_price') {
      const update = { updated_at: new Date().toISOString() };
      if (typeof price_cents === 'number' && price_cents > 0) update.price_cents = price_cents;
      if (typeof cost_price === 'number' && cost_price > 0) update.cost_price = cost_price;
      if (Object.keys(update).length === 1) return res.status(400).json({ error: 'no price provided' });
      const r = await _sbUpdate(`id=eq.${id}`, update);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'sb error', details: data });
      return res.status(200).json({ ok: true, action: 'set_price', product: data[0] || null });
    }

    // FLC FASE 5.1 — Edita specs (puffs, battery, liquid_ml, nicotine, description, name)
    if (action === 'update_specs') {
      const update = { updated_at: new Date().toISOString() };
      const { puffs, battery, liquid_ml, nicotine, description, name, flavor_sweet, flavor_ice, flavor_sour } = body;
      if (typeof puffs === 'number' && puffs > 0) update.puffs = puffs;
      if (typeof battery === 'string' && battery.trim()) update.battery = battery.trim();
      if (typeof liquid_ml === 'string' && liquid_ml.trim()) update.liquid_ml = liquid_ml.trim();
      if (typeof nicotine === 'string' && nicotine.trim()) update.nicotine = nicotine.trim();
      if (typeof description === 'string') update.description = description.trim().slice(0, 500);
      if (typeof name === 'string' && name.trim().length >= 3) update.name = name.trim().slice(0, 200);
      if (typeof flavor_sweet === 'number' && flavor_sweet >= 0 && flavor_sweet <= 5) update.flavor_sweet = flavor_sweet;
      if (typeof flavor_ice === 'number' && flavor_ice >= 0 && flavor_ice <= 5) update.flavor_ice = flavor_ice;
      if (typeof flavor_sour === 'number' && flavor_sour >= 0 && flavor_sour <= 5) update.flavor_sour = flavor_sour;
      if (Object.keys(update).length === 1) return res.status(400).json({ error: 'no fields to update' });
      const r = await _sbUpdate(`id=eq.${id}`, update);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'sb error', details: data });
      return res.status(200).json({ ok: true, action: 'update_specs', product: data[0] || null });
    }

    if (action === 'reject') {
      // Soft delete: marca como inactive, NAO deleta. Permite recuperar.
      const r = await _sbUpdate(`id=eq.${id}`, {
        status: 'inactive', hidden: true, updated_at: new Date().toISOString(),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'sb error', details: data });
      return res.status(200).json({ ok: true, action: 'reject', product: data[0] || null });
    }

    if (action === 'regenerate_art') {
      // Marca image_status='pending_art' e dispara nova pipeline
      await _sbUpdate(`id=eq.${id}`, {
        image_status: 'pending_art',
        updated_at: new Date().toISOString(),
      });
      _fireArt(id, 1).catch(() => {});
      return res.status(200).json({ ok: true, action: 'regenerate_art', dispatched: true });
    }

    return res.status(400).json({ error: 'unknown action: ' + action });
  } catch (err) {
    console.error('[admin-approve-product] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
