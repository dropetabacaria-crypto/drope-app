// Drope — Tasks Update (atualiza tarefa do painel)
// POST /api/tasks-update
//
// AUTH (dois modos com poderes diferentes):
//   x-admin-token: <ADMIN_TOKEN>  → ANDRADE: pode tudo
//   x-rafa-token:  <RAFA_TOKEN>   → RAFA:    pode mudar status (pending→in_progress→done) e
//                                            escrever feedback_rafa, SÓ em tarefas onde assignee='rafa'.
//
// Body JSON (admin):
//   { id: uuid, [title], [description], [assignee], [status], [priority], [category],
//     [location], [feedback_rafa], [feedback_andrade], [ai_take], [due_date], [metadata] }
//
// Body JSON (rafa) — só estes campos aceitos:
//   { id: uuid, [status: 'in_progress' | 'done'], [feedback_rafa] }
//
// Side-effect: notifica WhatsApp em transições importantes.
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN, RAFA_TOKEN
//           UAZAPI_SERVER, UAZAPI_TOKEN, ADMIN_LUCAS, RAFA_PHONE
//           CLAUDE_KEY (opcional — pra gerar ai_take quando Rafa marca done com feedback)

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const RAFA_TOKEN   = process.env.RAFA_TOKEN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";
const ADMIN_LUCAS   = process.env.ADMIN_LUCAS || "";
const RAFA_PHONE    = process.env.RAFA_PHONE || "";
const CLAUDE_KEY    = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || "";

const VALID_STATUS    = ['pending','in_progress','done','approved','rejected','cancelled'];
const VALID_PRIORITY  = ['alta','media','baixa'];
const VALID_ASSIGNEE  = ['andrade','rafa','code'];
const VALID_LOCATION  = ['remoto','presencial_andrade','presencial_rafa','loja','qualquer'];

// Transições permitidas pro Rafa (vista a partir de qualquer status atual)
const RAFA_ALLOWED_TRANSITIONS = {
  pending:     ['in_progress', 'done'],
  in_progress: ['done'],
  done:        [], // não mexe mais — agora é com Andrade
  approved:    [],
  rejected:    ['in_progress'], // pode retomar quando Andrade pediu refazer
  cancelled:   [],
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function sendWhatsApp(phone, text) {
  if (!phone || !UAZAPI_TOKEN) return { skipped: true, reason: 'no phone or token' };
  try {
    const r = await fetch(`${UAZAPI_SERVER}/send/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
      body: JSON.stringify({ number: phone, text }),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.error('[tasks-update] whatsapp error:', e.message);
    return { ok: false, error: e.message };
  }
}

// Gera ai_take curto a partir do feedback do Rafa (best-effort, falha silenciosa)
async function generateAiTake(taskTitle, taskDescription, feedbackRafa) {
  if (!CLAUDE_KEY || !feedbackRafa || feedbackRafa.length < 10) return null;
  try {
    const systemPrompt = `Voce e a IA assistente do painel Drope. Recebeu o feedback bruto do Rafa (operador) sobre uma tarefa, e produz um resumo curado pro Andrade (decisor).

Regras:
- Resumo em 2-4 linhas, tom direto Gen Z (nao corporativo, nao formal).
- Estrutura: VISÃO DO RAFA (1-2 bullets do que ele disse) + OPINIÃO IA (1-2 linhas com angulo que pode ter passado batido).
- Sem emojis, sem markdown formal, minusculas.
- Nunca invente dados que o Rafa nao disse.
- Se feedback for vago, peca pra Andrade pedir mais detalhe ao Rafa.
- Resposta em portugues brasileiro.`;

    const userMsg = `tarefa: "${taskTitle}"
${taskDescription ? `descricao: ${taskDescription.slice(0, 500)}\n` : ''}
feedback bruto do Rafa:
${feedbackRafa.slice(0, 1500)}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    const data = await r.json();
    if (r.status >= 400) {
      console.error('[tasks-update] claude error:', JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.error('[tasks-update] ai_take gen error:', e.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-rafa-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // 🔒 AUTH dual
  const adminProvided = req.headers['x-admin-token'] || '';
  const rafaProvided  = req.headers['x-rafa-token']  || '';
  let mode = null;
  if (ADMIN_TOKEN && adminProvided && adminProvided === ADMIN_TOKEN) mode = 'admin';
  else if (RAFA_TOKEN && rafaProvided && rafaProvided === RAFA_TOKEN) mode = 'rafa';

  if (!mode) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    const body = req.body || {};
    const { id } = body;
    if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
      return res.status(400).json({ error: 'invalid id (must be uuid)' });
    }

    // Busca tarefa atual pra validar regras
    const fetchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_tasks?id=eq.${id}&select=*&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const found = await fetchRes.json();
    if (!fetchRes.ok || !Array.isArray(found) || found.length === 0) {
      return res.status(404).json({ error: 'task not found' });
    }
    const current = found[0];

    // 🔒 Modo Rafa: verifica posse + restringe campos + valida transição
    const updates = {};
    if (mode === 'rafa') {
      if (current.assignee !== 'rafa') {
        return res.status(403).json({ error: 'forbidden: not your task' });
      }
      // Status: só transição permitida
      if (body.status !== undefined) {
        if (!VALID_STATUS.includes(body.status)) {
          return res.status(400).json({ error: 'invalid status' });
        }
        const allowed = RAFA_ALLOWED_TRANSITIONS[current.status] || [];
        if (!allowed.includes(body.status)) {
          return res.status(403).json({
            error: `forbidden transition for rafa: ${current.status} → ${body.status}`,
            allowed,
          });
        }
        updates.status = body.status;
      }
      // Feedback Rafa: livre
      if (body.feedback_rafa !== undefined) {
        if (body.feedback_rafa !== null && (typeof body.feedback_rafa !== 'string' || body.feedback_rafa.length > 4000)) {
          return res.status(400).json({ error: 'invalid feedback_rafa (max 4000 chars)' });
        }
        updates.feedback_rafa = body.feedback_rafa;
      }
      // Tudo o resto: silenciosamente ignorado (não erro — pra UX limpa)
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'no allowed updates provided (rafa pode mudar status ou feedback_rafa)' });
      }
    } else {
      // Modo admin: tudo liberado, com validações de tipo
      const allowed = ['title','description','assignee','status','priority','category','location',
                       'feedback_rafa','feedback_andrade','ai_take','due_date','metadata'];
      for (const k of allowed) {
        if (body[k] === undefined) continue;
        switch (k) {
          case 'title':
            if (body.title !== null && (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > 200))
              return res.status(400).json({ error: 'invalid title' });
            updates.title = body.title;
            break;
          case 'description':
            if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 4000))
              return res.status(400).json({ error: 'invalid description' });
            updates.description = body.description;
            break;
          case 'assignee':
            if (!VALID_ASSIGNEE.includes(body.assignee)) return res.status(400).json({ error: 'invalid assignee' });
            updates.assignee = body.assignee;
            break;
          case 'status':
            if (!VALID_STATUS.includes(body.status)) return res.status(400).json({ error: 'invalid status' });
            updates.status = body.status;
            // approved → registra quem aprovou
            if (body.status === 'approved') updates.approved_by = 'andrade';
            break;
          case 'priority':
            if (!VALID_PRIORITY.includes(body.priority)) return res.status(400).json({ error: 'invalid priority' });
            updates.priority = body.priority;
            break;
          case 'category':
            if (body.category !== null && (typeof body.category !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(body.category)))
              return res.status(400).json({ error: 'invalid category' });
            updates.category = body.category;
            break;
          case 'location':
            if (body.location !== null && !VALID_LOCATION.includes(body.location))
              return res.status(400).json({ error: 'invalid location' });
            updates.location = body.location;
            break;
          case 'feedback_rafa':
          case 'feedback_andrade':
          case 'ai_take':
            if (body[k] !== null && (typeof body[k] !== 'string' || body[k].length > 4000))
              return res.status(400).json({ error: `invalid ${k}` });
            updates[k] = body[k];
            break;
          case 'due_date':
            if (body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date))
              return res.status(400).json({ error: 'invalid due_date (YYYY-MM-DD)' });
            updates.due_date = body.due_date;
            break;
          case 'metadata':
            if (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
              return res.status(400).json({ error: 'invalid metadata (must be object)' });
            updates.metadata = body.metadata;
            break;
        }
      }
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'no updates provided' });
      }
    }

    // 🤖 Gerar ai_take se Rafa marcou done com feedback novo (best-effort)
    if (mode === 'rafa' && updates.status === 'done' && (updates.feedback_rafa || current.feedback_rafa)) {
      const fb = updates.feedback_rafa !== undefined ? updates.feedback_rafa : current.feedback_rafa;
      if (fb && fb.length >= 10) {
        const aiTake = await generateAiTake(current.title, current.description, fb);
        if (aiTake) updates.ai_take = aiTake;
      }
    }

    // PATCH no Supabase
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/drope_tasks?id=eq.${id}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(updates),
      }
    );
    const patchedRows = await patchRes.json();
    if (!patchRes.ok) {
      console.error('[tasks-update] patch error:', patchRes.status, patchedRows);
      return res.status(502).json({ error: 'update failed', details: patchedRows });
    }
    const updated = Array.isArray(patchedRows) ? patchedRows[0] : patchedRows;

    // 📲 Notificações de mudança importante
    const notifs = [];
    const statusChanged = updates.status && updates.status !== current.status;
    if (statusChanged) {
      // Rafa→done OU rejected → avisa Andrade
      if ((updates.status === 'done' || updates.status === 'rejected') && ADMIN_LUCAS) {
        const lines = [
          `🔔 tarefa: ${updated.title}`,
          ``,
          `status: ${current.status} → ${updates.status}`,
          updated.feedback_rafa ? `\nvisao do rafa:\n${updated.feedback_rafa.slice(0, 300)}` : '',
          updated.ai_take ? `\nopiniao da ia:\n${updated.ai_take.slice(0, 300)}` : '',
          ``,
          `painel: https://drope-app.vercel.app/admin#tarefas`,
        ].filter(Boolean);
        notifs.push(await sendWhatsApp(ADMIN_LUCAS, lines.join('\n')));
      }
      // Andrade→approved/rejected → avisa Rafa
      if ((updates.status === 'approved' || updates.status === 'rejected') && updated.assignee === 'rafa' && RAFA_PHONE) {
        const verb = updates.status === 'approved' ? '✅ aprovada' : '↩️ refazer';
        const lines = [
          `${verb}: ${updated.title}`,
          updated.feedback_andrade ? `\nresposta:\n${updated.feedback_andrade.slice(0, 500)}` : '',
        ].filter(Boolean);
        notifs.push(await sendWhatsApp(RAFA_PHONE, lines.join('\n')));
      }
    }

    return res.status(200).json({ ok: true, task: updated, mode, notifs });

  } catch (err) {
    console.error('[tasks-update] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
