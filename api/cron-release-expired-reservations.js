// Drope — Cron: Libera reservas de estoque de pedidos expirados
// POST /api/cron-release-expired-reservations
// Header: x-cron-token: <CRON_TOKEN>
//
// Roda 1x a cada 5-10min. Pega pedidos que reservaram estoque mas nunca evoluíram:
//   status IN ('created','waiting_proof','pending_pickup') AND created_at < now() - 30min
// Pra cada item com slug, devolve qty via drope_release_stock e marca pedido como 'expired'.
//
// Por que existe: o save-order.js decrementa estoque ATOMICAMENTE no momento da criação
// (modelo "reserva no checkout"). Se cliente abandona ou nunca paga via pix manual, o
// estoque fica travado. Esse cron libera depois de 30min.
//
// Idempotente: só pega quem ainda tá nos 3 status reservados. Após mudar pra 'expired',
// próxima execução pula o mesmo pedido.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, CRON_TOKEN, EXPIRY_MINUTES (default 30)

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const CRON_TOKEN   = process.env.CRON_TOKEN || "";
const EXPIRY_MINUTES = parseInt(process.env.EXPIRY_MINUTES || "30", 10);

// TODO[multi-tenant]: filtrar por tenant_id quando Plataforma sair do dormindo

// 'created' (infinitepay pendente) NÃO reserva mais estoque — a baixa só acontece
// no webhook ao confirmar o pagamento. Então o cron não deve devolver estoque de
// pedidos 'created' (senão sobe fantasma). Só waiting_proof/pending_pickup reservam.
const RESERVED_STATUSES = ['waiting_proof', 'pending_pickup'];

module.exports = async function handler(req, res) {
  // Aceita POST (cron-job.org, manual) e GET (Vercel Cron usa GET)
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // 🔒 AUTH — aceita header OU query (Vercel Cron envia via Authorization: Bearer <CRON_SECRET>)
  if (!CRON_TOKEN) return res.status(500).json({ error: 'CRON_TOKEN not configured' });
  const provided =
    req.headers['x-cron-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.query?.token ||
    '';
  if (provided !== CRON_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const sbHeaders = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };

  const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000).toISOString();

  try {
    // 1. Busca pedidos elegíveis: reservados + criados antes do cutoff
    const statusFilter = RESERVED_STATUSES.map(s => `"${s}"`).join(',');
    const listUrl =
      `${SUPABASE_URL}/rest/v1/drope_orders` +
      `?status=in.(${encodeURIComponent(statusFilter)})` +
      `&created_at=lt.${encodeURIComponent(cutoff)}` +
      `&select=order_nsu,status,items,created_at` +
      `&order=created_at.asc` +
      `&limit=200`;

    const listRes = await fetch(listUrl, { headers: sbHeaders });
    if (!listRes.ok) {
      const detail = await listRes.text();
      console.error('[cron-release] list failed:', listRes.status, detail);
      return res.status(502).json({ error: 'supabase list failed', details: detail });
    }
    const orders = await listRes.json();

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(200).json({ ok: true, expired: 0, released: 0, cutoff, scanned: 0 });
    }

    let totalReleased = 0;
    const expiredOrders = [];

    // 2. Pra cada pedido: libera estoque (item por item) e marca como expired
    for (const order of orders) {
      const items = Array.isArray(order.items) ? order.items : [];
      const releasable = items.filter(i => i && typeof i.slug === 'string' && typeof i.qty === 'number' && i.qty > 0);

      const releasedItems = [];
      for (const it of releasable) {
        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
          });
          if (r.ok) {
            releasedItems.push({ slug: it.slug, qty: it.qty });
            totalReleased += it.qty;
          } else {
            console.error(`[cron-release] release failed for ${it.slug}:`, r.status, await r.text());
          }
        } catch (e) {
          console.error(`[cron-release] release error for ${it.slug}:`, e.message);
        }
      }

      // 3. Marca pedido como expired (trigger drope_log_status_change registra no histórico automático)
      try {
        const updRes = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(order.order_nsu)}` +
          `&status=in.(${encodeURIComponent(statusFilter)})`, // re-checa status pra evitar race com webhook
          {
            method: 'PATCH',
            headers: { ...sbHeaders, Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'expired' }),
          }
        );
        if (!updRes.ok) {
          console.error(`[cron-release] mark-expired failed for ${order.order_nsu}:`, updRes.status);
          // Se PATCH falhou, ROLLBACK: re-decrementa o que tinha sido liberado pra não duplicar estoque
          for (const rel of releasedItems) {
            try {
              await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_consume_stock`, {
                method: 'POST',
                headers: sbHeaders,
                body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
              });
            } catch (e) { console.error('[cron-release] rollback err:', e.message); }
          }
          continue;
        }
        expiredOrders.push({
          order_nsu: order.order_nsu,
          previous_status: order.status,
          released: releasedItems,
          age_minutes: Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000),
        });
      } catch (e) {
        console.error(`[cron-release] mark-expired error for ${order.order_nsu}:`, e.message);
      }
    }

    console.log(`[cron-release] expired=${expiredOrders.length} released_units=${totalReleased} scanned=${orders.length}`);
    return res.status(200).json({
      ok: true,
      expired: expiredOrders.length,
      released: totalReleased,
      scanned: orders.length,
      cutoff,
      details: expiredOrders,
    });
  } catch (err) {
    console.error('[cron-release] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
