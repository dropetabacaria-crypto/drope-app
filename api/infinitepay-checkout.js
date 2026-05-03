// Drope — InfinitePay Checkout Link Generator (Vercel)
// Gera link de pagamento InfinitePay via API pública
// Endpoint: POST /api/infinitepay-checkout

module.exports = async function handler(req, res) {
  // CORS headers — restringe ao domínio da Drope
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  try {
    const { handle, items, total, order_id, customer } = req.body;

    if (!handle || !items || !items.length) {
      return res.status(400).json({ error: 'missing handle or items' });
    }

    // URLs dinâmicas — usam o host da requisição original (funciona em QUALQUER domínio Vercel)
    const protocol = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'drope-app.vercel.app';
    const redirectUrl = `${protocol}://${host}/#success-pay`;
    const webhookUrl  = `${protocol}://${host}/api/infinitepay-webhook`;

    // Monta payload com dados do cliente pra pré-preencher checkout
    // webhook_url: InfinitePay dispara POST aqui quando pagamento for aprovado.
    //   Nosso /api/infinitepay-webhook então marca pedido como 'paid' no Supabase
    //   e (futuro) notifica WhatsApp da loja via UazAPI.
    //
    // 🔒 description: SEMPRE "Tabacaria Drope" — nunca o nome real do produto.
    // Nome do pod no extrato bancário/fatura é zona cinza regulatória + confunde cliente.
    // O nome completo segue intacto no Supabase, app, bot e admin.
    const payload = {
      handle: handle,
      order_nsu: order_id || `drope-${Date.now()}`,
      redirect_url: redirectUrl,
      webhook_url:  webhookUrl,
      items: items.map(i => ({
        quantity: i.quantity,
        price: i.price,
        description: 'Tabacaria Drope'
      }))
    };

    // Se tem dados do cliente, manda pra pré-preencher
    if (customer && (customer.name || customer.email || customer.phone_number)) {
      payload.customer = {};
      if (customer.name) payload.customer.name = customer.name;
      if (customer.email) payload.customer.email = customer.email;
      if (customer.phone_number) payload.customer.phone_number = customer.phone_number;
    }

    // Gera o link de checkout via API pública da InfinitePay
    console.log('[InfinitePay] payload:', JSON.stringify(payload).substring(0, 400));
    const response = await fetch('https://api.infinitepay.io/invoices/public/checkout/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('[InfinitePay] status:', response.status, 'data:', JSON.stringify(data).substring(0, 300));

    if (response.ok && data.url) {
      return res.status(200).json({ url: data.url, id: data.id || data.invoice_slug });
    }

    // Fallback: monta URL direta do checkout público
    if (handle && total) {
      const fallbackUrl = `https://infinitepay.io/${handle}?amount=${total}`;
      console.log('[InfinitePay] usando fallback URL:', fallbackUrl);
      return res.status(200).json({ url: fallbackUrl, fallback: true });
    }

    return res.status(502).json({ error: 'infinitepay error', details: data });

  } catch (err) {
    console.error('[InfinitePay] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
