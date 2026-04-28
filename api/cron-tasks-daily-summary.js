// Drope — Cron: Resumo diário do painel de tarefas
// GET/POST /api/cron-tasks-daily-summary
// Header: x-cron-token: <CRON_TOKEN>   (também aceita Authorization: Bearer e ?token=)
//
// Roda 1x/dia às 9h America/Sao_Paulo. Conta o painel e manda resumo no WhatsApp do Andrade.
// Idempotente — pode rodar múltiplas vezes sem efeito colateral além de mandar mais 1 mensagem.
// (Pra agendar em cron-job.org: ajuste o fuso horário no painel deles).
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, CRON_TOKEN, UAZAPI_SERVER, UAZAPI_TOKEN, ADMIN_LUCAS

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const CRON_TOKEN   = process.env.CRON_TOKEN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";
const ADMIN_LUCAS   = process.env.ADMIN_LUCAS || "";

module.exports = async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // 🔒 AUTH
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

  try {
    // Busca counts em uma chamada (limit alto pra ter total)
    const url = `${SUPABASE_URL}/rest/v1/drope_tasks?status=in.("pending","in_progress","done","rejected")&select=assignee,status,priority,title,category&limit=500&order=created_at.desc`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('[cron-tasks-daily] supabase error:', r.status, detail);
      return res.status(502).json({ error: 'supabase error', details: detail });
    }
    const tasks = await r.json();

    // Agrega
    const byAssignee = { andrade: 0, rafa: 0, code: 0 };
    const byStatus = { pending: 0, in_progress: 0, done: 0, rejected: 0 };
    const decisoesAbertas = [];
    const rafaAtivas = [];
    const refazer = [];

    for (const t of tasks) {
      byAssignee[t.assignee] = (byAssignee[t.assignee] || 0) + 1;
      byStatus[t.status]     = (byStatus[t.status] || 0) + 1;

      if (t.assignee === 'andrade' && t.status === 'pending' &&
          (t.category === 'infra' || t.category === 'arquitetura' || /^DECIS[ÃA]O/i.test(t.title || ''))) {
        decisoesAbertas.push(t.title);
      }
      if (t.assignee === 'rafa' && (t.status === 'pending' || t.status === 'in_progress')) {
        rafaAtivas.push(t.title);
      }
      if (t.status === 'rejected') refazer.push(t.title);
    }

    const totalAtivas = byStatus.pending + byStatus.in_progress;
    const aguardando = byStatus.done; // done = esperando aprovação

    const lines = [
      `☀️ painel drope ✦ bom dia`,
      ``,
      `${totalAtivas} ativas · ${aguardando} aguardando martelo${refazer.length ? ` · ${refazer.length} pra refazer` : ''}`,
      ``,
      `por pessoa:`,
      `  andrade: ${byAssignee.andrade || 0}`,
      `  rafa: ${byAssignee.rafa || 0}`,
      `  code: ${byAssignee.code || 0}`,
    ];

    if (decisoesAbertas.length > 0) {
      lines.push('');
      lines.push(`⚖️ decisões esperando voce (${decisoesAbertas.length}):`);
      for (const title of decisoesAbertas.slice(0, 5)) {
        lines.push(`  • ${title.slice(0, 80)}`);
      }
    }

    if (aguardando > 0) {
      lines.push('');
      lines.push(`✓ done aguardando aprovação: ${aguardando}`);
    }

    lines.push('');
    lines.push(`painel: https://drope-app.vercel.app/admin#tarefas`);

    const text = lines.join('\n');

    // Envia se tiver canal configurado
    let sent = false;
    if (ADMIN_LUCAS && UAZAPI_TOKEN) {
      try {
        const sendRes = await fetch(`${UAZAPI_SERVER}/send/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
          body: JSON.stringify({ number: ADMIN_LUCAS, text }),
        });
        sent = sendRes.ok;
      } catch (e) {
        console.error('[cron-tasks-daily] send error:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      sent,
      counts: { totalAtivas, aguardando, refazer: refazer.length, byAssignee, byStatus },
      decisoes_abertas: decisoesAbertas.length,
      preview: text,
    });

  } catch (err) {
    console.error('[cron-tasks-daily] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
