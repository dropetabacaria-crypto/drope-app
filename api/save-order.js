// Drope — Save Order (CRM) Endpoint (Vercel)
// Recebe pedido do app e persiste no Supabase como fonte única de verdade.
// Chamado pelo index.html no confirmOrder() — cria registro central de cada pedido.
//
// ENV VARS necessárias (Vercel → Settings):
//   SUPABASE_URL, SUPABASE_KEY
//
// Payload esperado (POST JSON):
// {
//   "order_nsu": "dr-ABC123",
//   "status": "paid" | "waiting_proof" | "reserved" | ...,
//   "payment_method": "infinitepay" | "pix_manual" | "pickup_later",
//   "subtotal": 330,
//   "delivery_fee": 8,
//   "total": 338,
//   "items": [{name, qty, price}, ...],
//   "delivery_mode": "delivery" | "pickup",
//   "address": {...} | null,
//   "customer": {name, phone, email}
// }

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";


module.exports = async function handler(req, res) {
  // CORS restrito aos domínios Drope
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  try {
    const body = req.body || {};
    const {
      order_nsu, status = 'waiting_proof',
      payment_method = 'pix_manual',
      subtotal = 0, delivery_fee = 0, total = 0,
      items = [], delivery_mode, address = null,
      customer = {}
    } = body;

    if (!order_nsu) return res.status(400).json({ error: 'missing order_nsu' });

    // Upsert de CLIENTE (pelo telefone)
    let customerId = null;
    if (customer?.phone) {
      const phoneClean = String(customer.phone).replace(/\D/g, '');
      try {
        const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_customers?on_conflict=phone`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation,resolution=merge-duplicates',
          },
          body: JSON.stringify({
            phone: phoneClean,
            name: customer.name || null,
            email: customer.email || null,
            last_seen_at: new Date().toISOString(),
          }),
        });
        const rows = await upsertRes.json();
        if (Array.isArray(rows) && rows[0]) customerId = rows[0].id;
      } catch(e) { console.error('[save-order] customer upsert err:', e.message); }
    }

    // Insere ORDER
    const orderRow = {
      order_nsu,
      status,
      payment_method,
      subtotal_cents: Math.round(subtotal * 100),
      delivery_fee_cents: Math.round(delivery_fee * 100),
      total_cents: Math.round(total * 100),
      items: items,                              // jsonb
      delivery_mode: delivery_mode || null,
      address: address,                          // jsonb
      customer_id: customerId,
      customer_snapshot: customer,               // jsonb — foto do cliente no momento da compra
      created_at: new Date().toISOString(),
    };

    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_orders`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(orderRow),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      console.error('[save-order] insert err:', orderRes.status, orderData);
      return res.status(502).json({ error: 'supabase insert failed', details: orderData });
    }

    return res.status(200).json({ ok: true, order: Array.isArray(orderData) ? orderData[0] : orderData, customer_id: customerId });
  } catch (err) {
    console.error('[save-order] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
