// Drope — PDV Sale (venda presencial no balcão)
//
// ENDPOINTS:
//   GET  /api/pdv-sale?barcode=7891234567890   → busca produto pelo código de barras
//   GET  /api/pdv-sale?action=list             → lista todos produtos com barcode cadastrado
//   POST /api/pdv-sale                         → registra venda e dá baixa no estoque
//
// Header: x-admin-token: <ADMIN_TOKEN>
//
// POST Body:
// {
//   "items": [{ "slug": "elfbar-bc15000-morango", "qty": 1, "barcode": "789..." }],
//   "payment_method": "dinheiro" | "debito" | "credito" | "pix",
//   "operator": "pai" | "yasmim" | "mae" | "raquel" | "karla" | "vaniele"
// }
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const PDV_PIN      = process.env.PDV_PIN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";
const STORE_WHATS_NUMBER = process.env.STORE_WHATS_NUMBER || "";

module.exports = async function handler(req, res) {
  // CORS
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 🔒 AUTH — aceita PDV_PIN (balcão, 4 dígitos) ou ADMIN_TOKEN (admin web)
  if (!ADMIN_TOKEN && !PDV_PIN) return res.status(500).json({ error: 'auth not configured (need ADMIN_TOKEN or PDV_PIN)' });
  const provided = req.headers['x-admin-token'] || '';
  const isAdmin = !!ADMIN_TOKEN && provided === ADMIN_TOKEN;
  const isPdv   = !!PDV_PIN     && provided === PDV_PIN;
  if (!isAdmin && !isPdv) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    // ===== GET: Busca por barcode ou lista =====
    if (req.method === 'GET') {
      const action  = req.query?.action || '';
      const barcode = req.query?.barcode || '';

      // Lista todos produtos com barcode (pro PDV carregar catálogo)
      if (action === 'list') {
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_products?select=id,slug,name,price_cents,qty_available,category,badge,image_url,barcode,hidden&barcode=not.is.null&order=name.asc`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const rows = await r.json();
        if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });
        return res.status(200).json({ ok: true, products: rows, count: Array.isArray(rows) ? rows.length : 0 });
      }

      // Busca produto específico por barcode
      if (barcode) {
        // Sanitize: garante só dígitos (defensivo, frontend já sanitiza)
        const cleanBarcode = String(barcode).replace(/\D/g, '');
        if (!/^[0-9]{8,20}$/.test(cleanBarcode)) {
          console.log('[pdv-sale GET] invalid barcode format:', barcode, '→', cleanBarcode);
          return res.status(400).json({ error: 'invalid barcode format (8-20 digits)', received: barcode });
        }
        console.log('[pdv-sale GET] lookup barcode:', cleanBarcode);

        // Match exato primeiro
        const r = await fetch(
          `${SUPABASE_URL}/rest/v1/drope_products?barcode=eq.${encodeURIComponent(cleanBarcode)}&select=id,slug,name,price_cents,qty_available,category,badge,image_url,barcode,hidden`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const rows = await r.json();
        if (!r.ok) return res.status(502).json({ error: 'supabase error', details: rows });
        if (Array.isArray(rows) && rows.length > 0) {
          return res.status(200).json({ ok: true, product: rows[0] });
        }

        // Fallback EAN-13 ↔ UPC-A: alguns leitores adicionam/removem leading zero.
        // Se bipou 13 dígitos começando em 0, tenta os 12 sem o zero.
        // Se bipou 12 dígitos, tenta com 0 na frente.
        const candidates = [];
        if (cleanBarcode.length === 13 && cleanBarcode.startsWith('0')) candidates.push(cleanBarcode.slice(1));
        if (cleanBarcode.length === 12) candidates.push('0' + cleanBarcode);
        if (cleanBarcode.length === 14 && cleanBarcode.startsWith('0')) candidates.push(cleanBarcode.slice(1));

        for (const cand of candidates) {
          const r2 = await fetch(
            `${SUPABASE_URL}/rest/v1/drope_products?barcode=eq.${encodeURIComponent(cand)}&select=id,slug,name,price_cents,qty_available,category,badge,image_url,barcode,hidden`,
            { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
          );
          const rows2 = await r2.json();
          if (r2.ok && Array.isArray(rows2) && rows2.length > 0) {
            console.log('[pdv-sale GET] matched via EAN/UPC fallback:', cleanBarcode, '→', cand);
            return res.status(200).json({ ok: true, product: rows2[0], matched_via: 'ean_upc_fallback' });
          }
        }

        console.log('[pdv-sale GET] not found:', cleanBarcode, 'tried:', [cleanBarcode, ...candidates]);
        return res.status(404).json({ ok: false, error: 'product_not_found', barcode: cleanBarcode, tried: [cleanBarcode, ...candidates] });
      }

      return res.status(400).json({ error: 'missing barcode or action param' });
    }

    // ===== POST com action=defect: marcar produto como defeituoso =====
    // Body: { slug, qty=1, motivo='defeito', operator, barcode? }
    // Decrementa estoque (vai pra negativo se preciso, igual venda do PDV),
    // registra em drope_perdas, notifica Lucas via WhatsApp.
    if (req.method === 'POST' && req.query?.action === 'defect') {
      const body = req.body || {};
      const { slug, qty = 1, motivo = 'defeito', operator, barcode } = body;

      if (!slug || typeof slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(slug)) {
        return res.status(400).json({ error: 'invalid slug' });
      }
      const qtyNum = parseInt(qty);
      if (!Number.isInteger(qtyNum) || qtyNum < 1 || qtyNum > 50) {
        return res.status(400).json({ error: 'invalid qty (1-50)' });
      }
      const validMotivos = ['defeito', 'vencido', 'quebrado', 'devolucao', 'amostra', 'outro'];
      if (!validMotivos.includes(motivo)) {
        return res.status(400).json({ error: 'invalid motivo', valid: validMotivos });
      }

      // Busca o produto (id, name, qty atual)
      const prodRes = await fetch(
        `${SUPABASE_URL}/rest/v1/drope_products?slug=eq.${encodeURIComponent(slug)}&select=id,name,qty_available,barcode&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const prodRows = await prodRes.json();
      if (!prodRes.ok || !prodRows[0]) {
        return res.status(404).json({ error: 'product_not_found', slug });
      }
      const product = prodRows[0];

      // Decrementa estoque (drope_consume_stock_force vai pra negativo se preciso)
      const stockRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_consume_stock_force`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_slug: slug, p_qty: qtyNum }),
      });
      const stockResult = await stockRes.json();
      const stockRow = Array.isArray(stockResult) ? stockResult[0] : stockResult;
      if (!stockRow?.ok) {
        return res.status(502).json({ error: 'stock decrement failed', details: stockRow });
      }

      // Registra a perda
      const perdaRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_perdas`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({
          product_id: product.id,
          product_slug: slug,
          product_name: product.name,
          barcode: barcode || product.barcode || null,
          operator: operator || 'balcão',
          motivo,
          qty: qtyNum,
        }),
      });
      const perdaData = await perdaRes.json();
      if (!perdaRes.ok) {
        return res.status(502).json({ error: 'perda insert failed', details: perdaData });
      }

      // Notificar Lucas via WhatsApp (fire-and-forget)
      if (UAZAPI_SERVER && UAZAPI_TOKEN && STORE_WHATS_NUMBER) {
        const msg = `⚠️ produto marcado como ${motivo.toUpperCase()} no PDV\n\n• ${product.name}\n• qty: ${qtyNum}\n• operador: ${operator || 'balcão'}\n\nestoque: ${product.qty_available} → ${stockRow.qty_after}\n\nbom guardar pra trocar com o fornecedor.`;
        fetch(`${UAZAPI_SERVER}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
          body: JSON.stringify({ number: STORE_WHATS_NUMBER, text: msg }),
        }).catch(e => console.error('[pdv-sale defect] uazapi notify error:', e.message));
      }

      return res.status(200).json({
        ok: true,
        product: { id: product.id, slug, name: product.name },
        qty: qtyNum,
        motivo,
        qty_after: stockRow.qty_after,
        perda: Array.isArray(perdaData) ? perdaData[0] : perdaData,
      });
    }

    // ===== POST: Registrar venda =====
    if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

    const body = req.body || {};
    const { items = [], payment_method, operator } = body;

    // Validações
    const validPayMethods = ['dinheiro', 'debito', 'credito', 'pix'];
    if (!validPayMethods.includes(payment_method)) {
      return res.status(400).json({ error: 'invalid payment_method', valid: validPayMethods });
    }
    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res.status(400).json({ error: 'items must be array of 1-20 elements' });
    }

    // Validar cada item — items 'unregistered' (produto não cadastrado) seguem regras diferentes
    for (const it of items) {
      if (it.unregistered === true) {
        // Não cadastrado: sem slug, mas precisa barcode + price_cents
        if (typeof it.barcode !== 'string' || !/^[0-9]{8,20}$/.test(it.barcode)) {
          return res.status(400).json({ error: 'invalid unregistered barcode', item: it });
        }
        if (typeof it.price_cents !== 'number' || it.price_cents < 1 || it.price_cents > 10000000) {
          return res.status(400).json({ error: 'invalid unregistered price_cents', item: it });
        }
        if (typeof it.qty !== 'number' || it.qty < 1 || it.qty > 50) {
          return res.status(400).json({ error: 'invalid item qty', item: it });
        }
      } else {
        if (!it.slug || typeof it.slug !== 'string' || !/^[a-z0-9-]{1,80}$/.test(it.slug)) {
          return res.status(400).json({ error: 'invalid item slug', item: it });
        }
        if (typeof it.qty !== 'number' || it.qty < 1 || it.qty > 50) {
          return res.status(400).json({ error: 'invalid item qty', item: it });
        }
      }
    }

    // Separar items registrados dos não-cadastrados
    const registeredItems = items.filter(i => !i.unregistered);
    const unregisteredItems = items.filter(i => i.unregistered === true);

    // Buscar preços atuais dos produtos cadastrados (pra evitar manipulação client-side)
    const priceMap = {};
    if (registeredItems.length > 0) {
      const slugList = registeredItems.map(i => `"${i.slug}"`).join(',');
      const priceRes = await fetch(
        `${SUPABASE_URL}/rest/v1/drope_products?slug=in.(${encodeURIComponent(slugList)})&select=slug,name,price_cents,qty_available,image_url`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const priceRows = await priceRes.json();
      if (!priceRes.ok) return res.status(502).json({ error: 'price lookup failed', details: priceRows });
      (priceRows || []).forEach(p => { priceMap[p.slug] = p; });

      for (const it of registeredItems) {
        if (!priceMap[it.slug]) {
          return res.status(404).json({ error: 'product_not_found', slug: it.slug });
        }
      }
    }

    // 🔒 Decremento atômico de estoque — usa drope_consume_stock_force (não bloqueia mesmo qty<=0).
    // Loja online (save-order.js) continua usando drope_consume_stock normal pra bloquear vendas
    // sem estoque. PDV pode vender mesmo com qty=0 (estoque físico ≠ digital).
    const stockReleases = [];
    for (const it of registeredItems) {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_consume_stock_force`, {
        method: 'POST',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
      });
      const result = await r.json();
      const row = Array.isArray(result) ? result[0] : result;

      if (!row || !row.ok) {
        // Falhou (provavelmente product_not_found) — rollback
        for (const rel of stockReleases) {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
              method: 'POST',
              headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
            });
          } catch(e) { console.error('[pdv-sale] rollback err:', e.message); }
        }
        return res.status(404).json({
          error: row?.reason || 'stock_consume_failed',
          slug: it.slug,
          name: priceMap[it.slug]?.name,
        });
      }
      stockReleases.push({ slug: it.slug, qty: it.qty });
    }

    // Montar order — registrados pegam preço do banco, unregistered usa price_cents enviado
    const orderItems = [
      ...registeredItems.map(it => ({
        slug: it.slug,
        name: priceMap[it.slug].name,
        price: priceMap[it.slug].price_cents / 100,
        qty: it.qty,
        barcode: it.barcode || null,
      })),
      ...unregisteredItems.map(it => ({
        slug: null,
        name: `produto não cadastrado (${it.barcode})`,
        price: it.price_cents / 100,
        qty: it.qty,
        barcode: it.barcode,
        unregistered: true,
      })),
    ];

    const subtotalCents = orderItems.reduce((s, i) => s + Math.round(i.price * 100) * i.qty, 0);
    const nsu = `dr-pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const hasUnregistered = unregisteredItems.length > 0;

    const orderRow = {
      order_nsu: nsu,
      status: 'completed',
      payment_method,
      subtotal_cents: subtotalCents,
      delivery_fee_cents: 0,
      total_cents: subtotalCents,
      items: orderItems,
      delivery_mode: 'pos',
      address: null,
      customer_snapshot: { name: operator || 'balcão', phone: '', email: '' },
      metadata: hasUnregistered ? { has_unregistered: true, unregistered_count: unregisteredItems.length } : {},
      created_at: new Date().toISOString(),
    };

    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/drope_orders`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(orderRow),
    });
    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      // Rollback estoque
      for (const rel of stockReleases) {
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
            method: 'POST',
            headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
          });
        } catch(e) { console.error('[pdv-sale] rollback err:', e.message); }
      }
      return res.status(502).json({ error: 'order insert failed', details: orderData });
    }

    const savedOrder = Array.isArray(orderData) ? orderData[0] : orderData;

    // 📲 Notificar Lucas via WhatsApp se houve item não cadastrado
    // Fire-and-forget: falha aqui não trava a venda (já foi confirmada).
    if (hasUnregistered && UAZAPI_SERVER && UAZAPI_TOKEN && STORE_WHATS_NUMBER) {
      const lines = unregisteredItems.map(it =>
        `• código ${it.barcode}: R$ ${(it.price_cents / 100).toFixed(2)}`
      ).join('\n');
      const msg = `⚠️ venda de produto NÃO cadastrado no PDV\n\n${lines}\n\noperador: ${operator || 'balcão'}\npagamento: ${payment_method}\n\ncadastra esse(s) produto(s) quando puder pelo WhatsApp ✦ manda 3 fotos: barcode, caixa e pod`;
      fetch(`${UAZAPI_SERVER}/send/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
        body: JSON.stringify({ number: STORE_WHATS_NUMBER, text: msg }),
      }).catch(e => console.error('[pdv-sale] uazapi notify error:', e.message));
    }

    return res.status(200).json({
      ok: true,
      order_nsu: nsu,
      total: subtotalCents / 100,
      items_count: orderItems.length,
      payment_method,
      operator: operator || 'balcão',
      order: savedOrder,
      has_unregistered: hasUnregistered,
    });

  } catch (err) {
    console.error('[pdv-sale] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
