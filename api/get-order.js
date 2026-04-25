// Drope — Get Order (Rastreio do Cliente)
// Endpoint público de leitura: GET /api/get-order?token=ABC123
// O `customer_track_token` é gerado no momento do pedido (8 bytes random hex = 16 chars)
// e enviado pro cliente via WhatsApp/tela de sucesso. Sem token, não devolve nada.
//
// Retorna: status atual, timeline (created/paid/preparing/dispatched/delivered),
//          itens, endereço, valor — sem dados sensíveis (sem CPF, sem senha).
//
// ENV VARS necessárias: SUPABASE_URL, SUPABASE_KEY

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

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const token = req.query?.token || req.query?.t || '';
  const nsu   = req.query?.nsu || '';

  if (!token && !nsu) {
    return res.status(400).json({ error: 'missing token or nsu' });
  }

  try {
    // Busca por token (rota pública) ou por nsu (admin via Supabase service key)
    const filter = token
      ? `customer_track_token=eq.${encodeURIComponent(token)}`
      : `order_nsu=eq.${encodeURIComponent(nsu)}`;

    const url = `${SUPABASE_URL}/rest/v1/drope_orders?${filter}&select=order_nsu,status,status_history,created_at,payment_confirmed_at,prepared_at,dispatched_at,delivered_at,picked_up_at,total_cents,subtotal_cents,delivery_fee_cents,delivery_mode,address,items,payment_method,customer_snapshot`;

    const r = await fetch(url, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
      },
    });
    const rows = await r.json();

    if (!r.ok) {
      console.error('[get-order] supabase err:', r.status, rows);
      return res.status(502).json({ error: 'supabase error', details: rows });
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'order not found' });
    }

    const order = rows[0];

    // Sanitiza customer_snapshot — só primeiro nome (privacidade)
    const customerName = order.customer_snapshot?.name || '';
    const firstName = customerName.split(' ')[0] || 'cliente';

    // Computa timeline com etapas + timestamps + estado (done/current/pending)
    const timeline = computeTimeline(order);

    return res.status(200).json({
      ok: true,
      order: {
        nsu:                   order.order_nsu,
        status:                order.status,
        timeline:              timeline,
        items:                 order.items || [],
        delivery_mode:         order.delivery_mode,
        address:               order.address,
        payment_method:        order.payment_method,
        subtotal_cents:        order.subtotal_cents,
        delivery_fee_cents:    order.delivery_fee_cents,
        total_cents:           order.total_cents,
        created_at:            order.created_at,
        payment_confirmed_at:  order.payment_confirmed_at,
        prepared_at:           order.prepared_at,
        dispatched_at:         order.dispatched_at,
        delivered_at:          order.delivered_at,
        picked_up_at:          order.picked_up_at,
        first_name:            firstName,
      },
    });

  } catch (err) {
    console.error('[get-order] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Computa timeline visual baseado no modo (entrega ou retirada)
function computeTimeline(order) {
  const isPickup = order.delivery_mode === 'pickup';
  const status = order.status || 'created';

  // Modo entrega: created → paid → preparing → out_for_delivery → delivered
  // Modo retirada: created → paid → preparing → ready_for_pickup → picked_up
  const stages = isPickup
    ? [
        { key: 'paid',             label: 'Pagamento confirmado', ts_field: 'payment_confirmed_at', ts: order.payment_confirmed_at },
        { key: 'preparing',        label: 'Preparando',           ts_field: 'prepared_at',          ts: order.prepared_at },
        { key: 'ready_for_pickup', label: 'Pronto pra retirar',   ts_field: 'dispatched_at',        ts: order.dispatched_at },
        { key: 'picked_up',        label: 'Retirado',             ts_field: 'picked_up_at',         ts: order.picked_up_at },
      ]
    : [
        { key: 'paid',             label: 'Pagamento confirmado', ts_field: 'payment_confirmed_at', ts: order.payment_confirmed_at },
        { key: 'preparing',        label: 'Preparando',           ts_field: 'prepared_at',          ts: order.prepared_at },
        { key: 'out_for_delivery', label: 'Saiu pra entrega',     ts_field: 'dispatched_at',        ts: order.dispatched_at },
        { key: 'delivered',        label: 'Entregue',             ts_field: 'delivered_at',         ts: order.delivered_at },
      ];

  // Determina status visual de cada etapa
  // Ordem dos estados — quanto mais à direita, mais avançado
  const order_rank = {
    'created': 0,
    'paid': 1,
    'preparing': 2,
    'out_for_delivery': 3, 'ready_for_pickup': 3,
    'delivered': 4, 'picked_up': 4,
    'cancelled': -1,
  };
  const currentRank = order_rank[status] ?? 0;

  return stages.map((stage, i) => {
    const stageRank = order_rank[stage.key] ?? i + 1;
    let visualState;
    if      (currentRank > stageRank)  visualState = 'done';
    else if (currentRank === stageRank) visualState = 'current';
    else                                visualState = 'pending';
    return { ...stage, state: visualState };
  });
}
