// Drope — Check Stock (Osso 8)
// Endpoint público GET /api/check-stock
//   - sem query: retorna catálogo completo visível (não-hidden)
//   - ?slugs=a,b,c: retorna stock só desses
//   - ?slug=x&qty=2: validação rápida de uma compra (true/false)
//
// Cliente chama ANTES de gerar checkout pra evitar pedido em produto esgotado.
// Não decrementa nada — só leitura. O decremento atômico só acontece no save-order.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";

module.exports = async function handler(req, res) {
  // CORS
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    const slug   = req.query?.slug || '';
    const slugs  = req.query?.slugs || '';
    const qty    = parseInt(req.query?.qty || '1', 10);

    // 🔒 validação simples — slugs só letras/números/hífen, max 50 chars cada
    const slugRe = /^[a-z0-9-]{1,80}$/i;

    // Modo 1: validação rápida slug+qty
    if (slug) {
      if (!slugRe.test(slug)) return res.status(400).json({ error: 'invalid slug' });
      if (isNaN(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'invalid qty' });

      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}&hidden=eq.false&select=slug,qty_available`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(404).json({ ok: false, available: false, reason: 'product_not_found' });
      }
      const p = rows[0];
      const available = p.qty_available >= qty;
      return res.status(200).json({
        ok: true, available, slug: p.slug, qty_available: p.qty_available, qty_requested: qty,
        reason: available ? 'ok' : 'out_of_stock'
      });
    }

    // Modo 2: lista filtrada
    if (slugs) {
      const list = String(slugs).split(',').map(s => s.trim()).filter(s => slugRe.test(s));
      if (list.length === 0 || list.length > 50) return res.status(400).json({ error: 'invalid slugs' });

      const filter = list.map(s => `"${s}"`).join(',');
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/drope_products?slug=in.(${encodeURIComponent(filter)})&hidden=eq.false&select=slug,name,price_cents,qty_available,category,badge,image_url`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const rows = await r.json();
      return res.status(200).json({ ok: true, products: rows });
    }

    // Modo 3: catálogo completo visível
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_products?hidden=eq.false&select=slug,name,price_cents,qty_available,category,badge,image_url&order=qty_available.desc,name.asc`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });

    return res.status(200).json({ ok: true, products: rows, count: Array.isArray(rows) ? rows.length : 0 });

  } catch (err) {
    console.error('[check-stock] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
