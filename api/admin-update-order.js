// Drope — Admin Update Order (avança status do pedido)
// POST /api/admin-update-order
// Header: x-admin-token: <ADMIN_TOKEN>
// Body: { order_nsu: string, status: 'preparing'|'out_for_delivery'|'delivered'|'ready_for_pickup'|'picked_up'|'cancelled' }
//
// O trigger drope_log_status_change registra audit log automaticamente
// e atualiza o timestamp correspondente (prepared_at, dispatched_at, etc).
//
// Se status='cancelled' e os items tinham slug, devolve estoque.
//
// Opcional futuro: notificar cliente via WhatsApp quando status avança.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN, UAZAPI_SERVER, UAZAPI_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";

const VALID_STATUSES = ['created', 'paid', 'preparing', 'out_for_delivery', 'ready_for_pickup', 'delivered', 'picked_up', 'cancelled'];

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

  try {
    const { order_nsu, status, notify_customer = false } = req.body || {};

    // 🔒 Validação
    if (!order_nsu || typeof order_nsu !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(order_nsu)) {
      return res.status(400).json({ error: 'invalid order_nsu' });
    }
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status', valid: VALID_STATUSES });
    }

    // Busca pedido atual (pra logging + customer phone se for notificar)
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(order_nsu)}&select=id,status,items,customer_snapshot,customer_track_token`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const found = await getRes.json();
    if (!Array.isArray(found) || found.length === 0) {
      return res.status(404).json({ error: 'order not found' });
    }
    const oldOrder = found[0];

    // Update status (trigger atualiza timestamps + audit log)
    const updRes = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(order_nsu)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ status }),
      }
    );
    const updated = await updRes.json();
    if (!updRes.ok) return res.status(502).json({ error: 'supabase update failed', details: updated });

    // 🔒 Se cancelado, devolve estoque dos itens com slug
    if (status === 'cancelled' && oldOrder.status !== 'cancelled') {
      const items = oldOrder.items || [];
      for (const it of items) {
        if (it.slug && it.qty) {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
              method: 'POST',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
            });
          } catch(e) { console.error('[admin-update-order] stock release err:', e.message); }
        }
      }
    }

    // Notificar cliente via WhatsApp (opcional)
    if (notify_customer && UAZAPI_TOKEN) {
      const customerPhone = oldOrder.customer_snapshot?.phone || '';
      const phoneClean = String(customerPhone).replace(/\D/g, '');
      // Adiciona 55 se for número Brasil sem prefixo
      const fullPhone = phoneClean.length === 11 ? '55' + phoneClean : phoneClean;

      if (fullPhone.length >= 12) {
        const msgByStatus = {
          preparing: `🍳 Drope ✦ teu pedido *#${order_nsu}* tá sendo preparado!`,
          out_for_delivery: `🛵 Drope ✦ pedido *#${order_nsu}* saiu pra entrega!`,
          ready_for_pickup: `🏪 Drope ✦ pedido *#${order_nsu}* tá pronto pra retirar na loja!`,
          delivered: `📦 Drope ✦ pedido *#${order_nsu}* entregue ✓ obrigado pela preferência!`,
          picked_up: `🤝 Drope ✦ pedido *#${order_nsu}* retirado ✓ obrigado!`,
          cancelled: `❌ Drope ✦ pedido *#${order_nsu}* cancelado. Se foi engano, fala com a gente.`,
        };
        const msg = msgByStatus[status];
        if (msg) {
          try {
            await fetch(`${UAZAPI_SERVER}/send/text`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
              body: JSON.stringify({ number: fullPhone, text: msg }),
            });
          } catch(e) { console.error('[admin-update-order] whats err:', e.message); }
        }
      }
    }

    return res.status(200).json({
      ok: true,
      order: Array.isArray(updated) ? updated[0] : updated,
      previous_status: oldOrder.status,
      new_status: status,
    });

  } catch (err) {
    console.error('[admin-update-order] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
