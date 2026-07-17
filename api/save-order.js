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
      order_nsu,
      payment_method = 'pix_manual',
      subtotal = 0, delivery_fee = 0, total = 0,
      items = [], delivery_mode, address = null,
      customer = {}
    } = body;

    // Status inicial inteligente baseado no método de pagamento
    // (cliente pode override mandando status no body, mas default é por método)
    const defaultStatus =
      payment_method === 'infinitepay'   ? 'created' :        // será atualizado pra 'paid' pelo webhook
      payment_method === 'pix_manual'    ? 'waiting_proof' :  // espera comprovante via whats
      payment_method === 'pickup_later'  ? 'pending_pickup' : // pagar na retirada
      'created';
    const status = body.status || defaultStatus;

    if (!order_nsu) return res.status(400).json({ error: 'missing order_nsu' });

    // 🔒 Validação de payload — bloqueia atacantes inflando DB com pedidos fake
    if (typeof order_nsu !== 'string' || order_nsu.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(order_nsu)) {
      return res.status(400).json({ error: 'invalid order_nsu format' });
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'items must be array of 1-50 elements' });
    }
    if (typeof total !== 'number' || total < 0 || total > 100000) {
      return res.status(400).json({ error: 'invalid total (must be 0-100000)' });
    }
    if (typeof subtotal !== 'number' || subtotal < 0 || subtotal > 100000) {
      return res.status(400).json({ error: 'invalid subtotal' });
    }
    if (typeof delivery_fee !== 'number' || delivery_fee < 0 || delivery_fee > 1000) {
      return res.status(400).json({ error: 'invalid delivery_fee' });
    }
    // valida cada item
    for (const it of items) {
      if (!it || typeof it !== 'object') return res.status(400).json({ error: 'invalid item' });
      if (typeof it.name !== 'string' || it.name.length > 200) return res.status(400).json({ error: 'invalid item.name' });
      if (typeof it.qty !== 'number' || it.qty < 1 || it.qty > 100) return res.status(400).json({ error: 'invalid item.qty' });
      if (typeof it.price !== 'number' || it.price < 0 || it.price > 100000) return res.status(400).json({ error: 'invalid item.price' });
    }
    // valida customer (campos opcionais mas se vierem, trunca pra evitar bloat)
    if (customer && typeof customer === 'object') {
      if (customer.name && typeof customer.name === 'string') customer.name = customer.name.slice(0, 100);
      if (customer.phone && typeof customer.phone === 'string') customer.phone = customer.phone.slice(0, 30);
      if (customer.email && typeof customer.email === 'string') customer.email = customer.email.slice(0, 100);
    }

    // Upsert de CLIENTE (pelo telefone) — FEATURE 3B
    // source='app' marca quem veio pelo checkout. Se a coluna `source` ainda não existe
    // (migration osso20 não rodou), o INSERT falha e fazemos fallback sem source.
    let customerId = null;
    if (customer?.phone) {
      const phoneClean = String(customer.phone).replace(/\D/g, '');
      const baseRow = {
        phone: phoneClean,
        name: customer.name || null,
        email: customer.email || null,
        last_seen_at: new Date().toISOString(),
      };
      const upsertHeaders = {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation,resolution=merge-duplicates',
      };
      try {
        // 1ª tentativa: com source='app'
        let upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_customers?on_conflict=phone`, {
          method: 'POST',
          headers: upsertHeaders,
          body: JSON.stringify({ ...baseRow, source: 'app' }),
        });
        if (!upsertRes.ok) {
          // Fallback sem source (coluna ainda não existe — migration osso20 pendente)
          upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_customers?on_conflict=phone`, {
            method: 'POST',
            headers: upsertHeaders,
            body: JSON.stringify(baseRow),
          });
        }
        const rows = await upsertRes.json();
        if (Array.isArray(rows) && rows[0]) customerId = rows[0].id;
      } catch(e) { console.error('[save-order] customer upsert err:', e.message); }
    }

    // 🔒 Osso 8: validação de estoque + decremento atômico ANTES de criar pedido
    // Cada item deve ter `slug` (do catálogo Supabase). Se faltar, é pedido legacy
    // (catálogo hardcoded antigo) — pula stock check pra não quebrar.
    const stockReleases = []; // pra rollback se algo der errado depois
    const itemsWithSlug = items.filter(i => i.slug && typeof i.slug === 'string');

    // Estoque só sai na CONFIRMAÇÃO do pagamento. Pedido infinitepay nasce 'created'
    // (pendente) e NÃO baixa estoque aqui — o webhook baixa quando o Pix cair.
    // (pix_manual/pickup_later seguem reservando na criação, como antes.)
    if (itemsWithSlug.length > 0 && payment_method !== 'infinitepay') {
      for (const it of itemsWithSlug) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_consume_stock`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
          });
          const result = await r.json();
          const row = Array.isArray(result) ? result[0] : result;
          if (!row || !row.ok) {
            // Rollback dos decrementos já feitos antes de falhar
            for (const rel of stockReleases) {
              try {
                await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
                  method: 'POST',
                  headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
                });
              } catch(e) { console.error('[save-order] rollback err:', e.message); }
            }
            return res.status(409).json({
              error: 'out_of_stock',
              item: it.name,
              slug: it.slug,
              reason: row?.reason || 'unknown',
              qty_available: row?.qty_after !== undefined ? row.qty_after : null,
            });
          }
          stockReleases.push({ slug: it.slug, qty: it.qty });
        } catch(e) {
          console.error('[save-order] stock check err:', e.message);
          // Em erro de stock, NÃO bloqueia pedido (graceful degradation), mas loga
        }
      }
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
      // 🔒 Rollback: devolve estoque que foi decrementado se o INSERT do pedido falhou
      for (const rel of stockReleases) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
          });
        } catch(e) { console.error('[save-order] rollback err:', e.message); }
      }
      return res.status(502).json({ error: 'supabase insert failed', details: orderData });
    }

    const savedOrder = Array.isArray(orderData) ? orderData[0] : orderData;

    // OSSO 21 — IA-FIRST: enriquece drope_customers com dados de recompra
    // (last_product_id, last_order_date, last_delivery_address) e incrementa
    // total_orders. Isso alimenta:
    //   - Feature 1 (home recorrente "dropar de novo")
    //   - Feature 2 (recompra 1 toque com endereço pré-preenchido)
    //   - Feature 4 (perfil de sabor consolida com base nos pedidos)
    // Tudo fire-and-forget — falha aqui NÃO trava o pedido. As colunas só
    // foram criadas pela migration osso21; se ainda não rodou, o PATCH dá
    // erro silencioso e seguimos.
    if (customerId && itemsWithSlug.length > 0) {
      try {
        // 1ª escolha pra "último produto": o primeiro item do pedido.
        // (heurística simples — futuro: ranking por preço ou perfil)
        const lastSlug = itemsWithSlug[0].slug;
        const lastProductRows = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(lastSlug)}&select=id&limit=1`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        ).then(r => r.ok ? r.json() : []);
        const lastProductId = Array.isArray(lastProductRows) && lastProductRows[0] ? lastProductRows[0].id : null;

        const customerPatch = {
          last_order_date: new Date().toISOString(),
          last_delivery_address: address || null,
        };
        if (lastProductId) customerPatch.last_product_id = lastProductId;

        // total_orders: increment via SQL é mais correto, mas RPC não existe.
        // Fazemos GET + PATCH (suficiente pra MVP — app é single-tenant,
        // probabilidade de race condition baixa). Se total_orders ainda não
        // existe (migration osso21 pendente), o GET ignora gracefully.
        const curRes = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_customers?id=eq.${customerId}&select=total_orders`,
          { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
        );
        if (curRes.ok) {
          const curRows = await curRes.json();
          const cur = Array.isArray(curRows) && curRows[0] ? curRows[0] : {};
          if (typeof cur.total_orders === 'number') {
            customerPatch.total_orders = cur.total_orders + 1;
          }
        }

        await fetch(
          `${SUPABASE_URL}/rest/v1/drope_customers?id=eq.${customerId}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(customerPatch),
          }
        );
      } catch (e) {
        console.error('[save-order] customer enrich err:', e.message);
      }

      // Incrementa total_sold de cada produto (fire-and-forget).
      for (const it of itemsWithSlug) {
        fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_increment_total_sold`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
        }).catch(e => console.error('[save-order] total_sold rpc err:', e.message));
      }
    }

    // Retorna inclusive o `customer_track_token` (gerado pelo default da coluna)
    // pra o app salvar e mandar pro cliente como link de rastreio.
    return res.status(200).json({
      ok: true,
      order: savedOrder,
      customer_id: customerId,
      track_token: savedOrder?.customer_track_token || null,
      track_url: savedOrder?.customer_track_token
        ? `https://drope-app.vercel.app/#track/${savedOrder.customer_track_token}`
        : null,
    });
  } catch (err) {
    console.error('[save-order] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
