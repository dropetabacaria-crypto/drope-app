// Drope — InfinitePay Webhook Handler (Vercel)
// Recebe notificação do InfinitePay quando pagamento é confirmado.
// - Salva/atualiza pedido no Supabase como PAGO
// - Notifica WhatsApp da loja via UazAPI com resumo
//
// CONFIGURAR NO PAINEL INFINITEPAY:
//   dashboard.infinitepay.io → Webhooks / Integrações
//   URL: https://drope-app.vercel.app/api/infinitepay-webhook
//   Evento: "payment.approved" (ou equivalente)
//
// ENV VARS NECESSÁRIAS (Vercel → Settings → Environment Variables):
//   SUPABASE_URL              já existe no webhook.js principal
//   SUPABASE_KEY              já existe
//   UAZAPI_SERVER             https://dropepod.uazapi.com
//   UAZAPI_TOKEN              token da instância que atende Drope
//   STORE_WHATS_NUMBER        telefone de quem recebe alerta (ex: 5511924810126)
//   INFINITEPAY_WEBHOOK_SECRET  (opcional) shared secret pra validar origem
//
// Payload esperado (formato do InfinitePay, pode ajustar conforme doc oficial):
// {
//   "event": "payment.approved",
//   "transaction_id": "...",
//   "order_nsu": "drope-xxxxx",
//   "amount": 33800,           // centavos
//   "payment_method": "pix",
//   "customer": { "name": "...", "email": "...", "phone_number": "..." }
// }

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN = process.env.UAZAPI_TOKEN || "";
const STORE_WHATS_NUMBER = process.env.STORE_WHATS_NUMBER || "5511924810126";
const INFINITEPAY_WEBHOOK_SECRET = process.env.INFINITEPAY_WEBHOOK_SECRET || "";


module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    // 1. (Opcional) valida shared secret via header — acrescentar no painel InfinitePay
    if (INFINITEPAY_WEBHOOK_SECRET) {
      const provided = req.headers['x-webhook-secret'] || req.headers['x-infinitepay-signature'];
      if (provided !== INFINITEPAY_WEBHOOK_SECRET) {
        console.warn('[InfinitePay Webhook] invalid secret');
        return res.status(401).json({ error: 'unauthorized' });
      }
    }

    const body = req.body || {};
    console.log('[InfinitePay Webhook] payload recebido:', JSON.stringify(body).substring(0, 400));

    // 2. Extrai campos (ajuste conforme formato real do InfinitePay)
    const event = body.event || body.type || 'unknown';
    const transactionId = body.transaction_id || body.transactionId || body.id;
    const orderNsu = body.order_nsu || body.orderNsu || body.nsu || '';
    const amountCents = body.amount || body.total || 0;
    const paymentMethod = body.payment_method || body.paymentMethod || 'pix';
    const customer = body.customer || {};

    // 3. Só processa eventos de pagamento APROVADO (ignora refund/pending/etc)
    const approvedEvents = ['payment.approved', 'payment.confirmed', 'transaction.approved', 'approved'];
    if (!approvedEvents.includes(String(event).toLowerCase())) {
      console.log('[InfinitePay Webhook] evento ignorado:', event);
      return res.status(200).json({ ok: true, ignored: true, event });
    }

    // 4. Marca pedido como PAGO no Supabase (atualiza ou insere)
    if (SUPABASE_URL && SUPABASE_KEY && orderNsu) {
      try {
        // Tenta ATUALIZAR primeiro (se o pedido já foi salvo pelo /api/save-order)
        const updateRes = await fetch(
          `${SUPABASE_URL}/rest/v1/orders?order_nsu=eq.${encodeURIComponent(orderNsu)}`,
          {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify({
              status: 'paid',
              payment_confirmed_at: new Date().toISOString(),
              transaction_id: transactionId,
              amount_paid_cents: amountCents,
            }),
          }
        );
        const updated = await updateRes.json();
        console.log('[InfinitePay Webhook] Supabase update status:', updateRes.status, 'rows:', Array.isArray(updated) ? updated.length : 'n/a');
      } catch (e) {
        console.error('[InfinitePay Webhook] Supabase update error:', e.message);
      }
    } else {
      console.warn('[InfinitePay Webhook] Supabase não configurado — pulando persistência');
    }

    // 5. Notifica WhatsApp da loja via UazAPI
    if (UAZAPI_TOKEN && STORE_WHATS_NUMBER) {
      try {
        const amountBRL = (amountCents / 100).toFixed(2).replace('.', ',');
        const customerLine = customer.name
          ? `${customer.name}${customer.phone_number ? ' · ' + customer.phone_number : ''}`
          : 'cliente';
        const lines = [
          `💰 *PAGAMENTO CONFIRMADO* ✅`,
          ``,
          `Pedido: *#${orderNsu}*`,
          `Valor: *R$ ${amountBRL}*`,
          `Método: ${paymentMethod}`,
          ``,
          `👤 ${customerLine}`,
          ``,
          `_Drope ✦ InfinitePay Webhook_`,
        ];
        await fetch(`${UAZAPI_SERVER}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'token': UAZAPI_TOKEN },
          body: JSON.stringify({ number: STORE_WHATS_NUMBER, text: lines.join('\n') }),
        });
        console.log('[InfinitePay Webhook] whatsapp loja notificado');
      } catch (e) {
        console.error('[InfinitePay Webhook] whatsapp err:', e.message);
      }
    } else {
      console.warn('[InfinitePay Webhook] UazAPI não configurada — pulando notificação');
    }

    return res.status(200).json({ ok: true, processed: true, orderNsu, transactionId });

  } catch (err) {
    console.error('[InfinitePay Webhook] ERROR:', err.message);
    // Retorna 200 mesmo em erro pra InfinitePay não ficar retentando infinito.
    // Logs capturam o erro pra debug.
    return res.status(200).json({ ok: false, error: err.message });
  }
};
