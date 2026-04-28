// Drope — Tasks Unified Endpoint (consolida list/create/update + crons num 1 arquivo)
// /api/tasks  — todas as operações do painel drope_tasks
//
// Razão: Vercel Hobby plan limita 12 Serverless Functions. Consolidar 5 endpoints
// em 1 só mantém o comportamento e encaixa no limite.
//
// === OPERAÇÕES ===
//
//   GET  /api/tasks                      → LIST (auth: x-admin-token OU x-rafa-token)
//   POST /api/tasks?op=create            → CREATE (auth: x-admin-token)
//   POST /api/tasks?op=update            → UPDATE (auth: x-admin-token OU x-rafa-token)
//   POST /api/tasks?op=cron-release      → libera reservas >30min (auth: x-cron-token)
//   POST /api/tasks?op=cron-daily        → ping diário 9h SP (auth: x-cron-token)
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN, RAFA_TOKEN, CRON_TOKEN,
//           UAZAPI_SERVER, UAZAPI_TOKEN, ADMIN_LUCAS, RAFA_PHONE,
//           CLAUDE_KEY (opcional, pra ai_take), EXPIRY_MINUTES (default 30)

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SUPABASE_KEY  = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || "";
const RAFA_TOKEN    = process.env.RAFA_TOKEN || "";
const CRON_TOKEN    = process.env.CRON_TOKEN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";
const ADMIN_LUCAS   = process.env.ADMIN_LUCAS || "";
const RAFA_PHONE    = process.env.RAFA_PHONE || "";
const CLAUDE_KEY    = process.env.CLAUDE_KEY || process.env.ANTHROPIC_API_KEY || "";
const EXPIRY_MINUTES = parseInt(process.env.EXPIRY_MINUTES || "30", 10);

const VALID_STATUS    = ['pending','in_progress','done','approved','rejected','cancelled'];
const VALID_PRIORITY  = ['alta','media','baixa'];
const VALID_ASSIGNEE  = ['andrade','rafa','code'];
const VALID_LOCATION  = ['remoto','presencial_andrade','presencial_rafa','loja','qualquer'];

const RAFA_ALLOWED_TRANSITIONS = {
  pending:     ['in_progress', 'done'],
  in_progress: ['done'],
  done:        [],
  approved:    [],
  rejected:    ['in_progress'],
  cancelled:   [],
};

const RESERVED_STATUSES = ['created', 'waiting_proof', 'pending_pickup'];
const PRIORITY_EMOJI = { alta: '🔴', media: '🟡', baixa: '🟢' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ============ helpers ============
function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function bearerOr(headerName, queryName, req) {
  return req.headers[headerName] ||
         (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
         req.query?.[queryName] ||
         '';
}

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
    console.error('[tasks] whatsapp err:', e.message);
    return { ok: false, error: e.message };
  }
}

function phoneFor(assignee) {
  if (assignee === 'rafa')    return RAFA_PHONE;
  if (assignee === 'andrade') return ADMIN_LUCAS;
  return null;
}

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
      console.error('[tasks] claude err:', JSON.stringify(data).slice(0, 200));
      return null;
    }
    return data.content?.[0]?.text || null;
  } catch (e) {
    console.error('[tasks] ai_take gen err:', e.message);
    return null;
  }
}

function setCors(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-rafa-token, x-cron-token');
}

function authMode(req) {
  const adminProvided = req.headers['x-admin-token'] || '';
  const rafaProvided  = req.headers['x-rafa-token']  || '';
  if (ADMIN_TOKEN && adminProvided && adminProvided === ADMIN_TOKEN) return 'admin';
  if (RAFA_TOKEN  && rafaProvided  && rafaProvided  === RAFA_TOKEN)  return 'rafa';
  return null;
}

// ============ OP: LIST ============
async function opList(req, res) {
  const mode = authMode(req);
  if (!mode) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit || '200', 10) || 200));
  const includeCompleted = String(req.query?.include_completed || '').toLowerCase() === 'true';

  let assigneeList;
  if (mode === 'rafa') {
    assigneeList = ['rafa'];
  } else {
    const aParam = req.query?.assignee || '';
    assigneeList = aParam ? String(aParam).split(',').map(s => s.trim()).filter(s => VALID_ASSIGNEE.includes(s)) : [];
  }

  const sParam = req.query?.status || '';
  const statusList = sParam ? String(sParam).split(',').map(s => s.trim()).filter(s => VALID_STATUS.includes(s)) : [];

  const pParam = req.query?.priority || '';
  const priorityList = pParam ? String(pParam).split(',').map(s => s.trim()).filter(s => VALID_PRIORITY.includes(s)) : [];

  const cParam = req.query?.category || '';
  const categoryList = cParam ? String(cParam).split(',').map(s => s.trim()).filter(s => /^[a-z0-9_-]{1,40}$/i.test(s)) : [];

  const parts = ['select=*', `limit=${limit}`, 'order=created_at.desc'];
  if (assigneeList.length) parts.push(`assignee=in.(${assigneeList.map(s => `"${s}"`).join(',')})`);
  if (statusList.length)   parts.push(`status=in.(${statusList.map(s => `"${s}"`).join(',')})`);
  if (priorityList.length) parts.push(`priority=in.(${priorityList.map(s => `"${s}"`).join(',')})`);
  if (categoryList.length) parts.push(`category=in.(${categoryList.map(s => `"${s}"`).join(',')})`);
  if (!includeCompleted && !statusList.length) {
    parts.push(`status=in.("pending","in_progress","done","rejected")`);
  }

  const url = `${SUPABASE_URL}/rest/v1/drope_tasks?${parts.join('&')}`;
  const r = await fetch(url, { headers: sbHeaders() });
  const rows = await r.json();
  if (!r.ok) {
    console.error('[tasks/list] sb err:', r.status, rows);
    return res.status(502).json({ error: 'supabase error', details: rows });
  }

  const tasks = mode === 'rafa'
    ? rows.map(t => { const { feedback_andrade, approved_by, approved_at, ...safe } = t; return safe; })
    : rows;

  const counts = { total: rows.length, by_status: {}, by_priority: {}, by_assignee: {} };
  for (const t of rows) {
    counts.by_status[t.status]     = (counts.by_status[t.status] || 0) + 1;
    counts.by_priority[t.priority] = (counts.by_priority[t.priority] || 0) + 1;
    counts.by_assignee[t.assignee] = (counts.by_assignee[t.assignee] || 0) + 1;
  }

  return res.status(200).json({ ok: true, mode, tasks, counts });
}

// ============ OP: CREATE ============
async function opCreate(req, res) {
  const mode = authMode(req);
  if (mode !== 'admin') {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized (admin only)' });
  }

  const body = req.body || {};
  const { title, description, assignee, priority, category, location, due_date, metadata } = body;

  if (!title || typeof title !== 'string' || title.length === 0 || title.length > 200) {
    return res.status(400).json({ error: 'invalid title (1-200 chars)' });
  }
  if (description !== undefined && (typeof description !== 'string' || description.length > 4000)) {
    return res.status(400).json({ error: 'invalid description' });
  }
  if (!VALID_ASSIGNEE.includes(assignee)) {
    return res.status(400).json({ error: `invalid assignee` });
  }
  const prio = priority || 'media';
  if (!VALID_PRIORITY.includes(prio)) return res.status(400).json({ error: `invalid priority` });
  if (category !== undefined && (typeof category !== 'string' || category.length > 40 || !/^[a-z0-9_-]+$/i.test(category))) {
    return res.status(400).json({ error: 'invalid category' });
  }
  if (location !== undefined && location !== null && !VALID_LOCATION.includes(location)) {
    return res.status(400).json({ error: 'invalid location' });
  }
  if (due_date !== undefined && due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'invalid due_date' });
  }
  if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    return res.status(400).json({ error: 'invalid metadata' });
  }

  const row = {
    title: title.trim().slice(0, 200),
    description: description ? description.trim().slice(0, 4000) : null,
    assignee, priority: prio,
    category: category || null,
    location: location || null,
    due_date: due_date || null,
    created_by: 'andrade',
    metadata: metadata || {},
  };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_tasks`, {
    method: 'POST',
    headers: sbHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify(row),
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: 'insert failed', details: data });
  const task = Array.isArray(data) ? data[0] : data;

  let notif = { skipped: true };
  const phone = phoneFor(assignee);
  if (phone) {
    const emoji = PRIORITY_EMOJI[prio] || '';
    const link = `https://drope-app.vercel.app/admin#tarefas`;
    const lines = [
      `📋 nova tarefa ${emoji}`, '',
      `*${task.title}*`,
      task.description ? task.description.slice(0, 200) + (task.description.length > 200 ? '...' : '') : null,
      '', `prioridade: ${prio}`, `painel: ${link}`,
    ].filter(Boolean);
    notif = await sendWhatsApp(phone, lines.join('\n'));
  }

  return res.status(200).json({ ok: true, task, notif });
}

// ============ OP: UPDATE ============
async function opUpdate(req, res) {
  const mode = authMode(req);
  if (!mode) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const body = req.body || {};
  const { id } = body;
  if (!id || typeof id !== 'string' || !UUID_RE.test(id)) {
    return res.status(400).json({ error: 'invalid id' });
  }

  const fetchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/drope_tasks?id=eq.${id}&select=*&limit=1`,
    { headers: sbHeaders() }
  );
  const found = await fetchRes.json();
  if (!fetchRes.ok || !Array.isArray(found) || found.length === 0) {
    return res.status(404).json({ error: 'task not found' });
  }
  const current = found[0];

  const updates = {};
  if (mode === 'rafa') {
    if (current.assignee !== 'rafa') return res.status(403).json({ error: 'forbidden: not your task' });
    if (body.status !== undefined) {
      if (!VALID_STATUS.includes(body.status)) return res.status(400).json({ error: 'invalid status' });
      const allowed = RAFA_ALLOWED_TRANSITIONS[current.status] || [];
      if (!allowed.includes(body.status)) {
        return res.status(403).json({ error: `forbidden transition: ${current.status} → ${body.status}`, allowed });
      }
      updates.status = body.status;
    }
    if (body.feedback_rafa !== undefined) {
      if (body.feedback_rafa !== null && (typeof body.feedback_rafa !== 'string' || body.feedback_rafa.length > 4000)) {
        return res.status(400).json({ error: 'invalid feedback_rafa' });
      }
      updates.feedback_rafa = body.feedback_rafa;
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no allowed updates (rafa: status ou feedback_rafa)' });
    }
  } else {
    const allowed = ['title','description','assignee','status','priority','category','location',
                     'feedback_rafa','feedback_andrade','ai_take','due_date','metadata'];
    for (const k of allowed) {
      if (body[k] === undefined) continue;
      switch (k) {
        case 'title':
          if (body.title !== null && (typeof body.title !== 'string' || body.title.length === 0 || body.title.length > 200))
            return res.status(400).json({ error: 'invalid title' });
          updates.title = body.title; break;
        case 'description':
          if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 4000))
            return res.status(400).json({ error: 'invalid description' });
          updates.description = body.description; break;
        case 'assignee':
          if (!VALID_ASSIGNEE.includes(body.assignee)) return res.status(400).json({ error: 'invalid assignee' });
          updates.assignee = body.assignee; break;
        case 'status':
          if (!VALID_STATUS.includes(body.status)) return res.status(400).json({ error: 'invalid status' });
          updates.status = body.status;
          if (body.status === 'approved') updates.approved_by = 'andrade';
          break;
        case 'priority':
          if (!VALID_PRIORITY.includes(body.priority)) return res.status(400).json({ error: 'invalid priority' });
          updates.priority = body.priority; break;
        case 'category':
          if (body.category !== null && (typeof body.category !== 'string' || !/^[a-z0-9_-]{1,40}$/i.test(body.category)))
            return res.status(400).json({ error: 'invalid category' });
          updates.category = body.category; break;
        case 'location':
          if (body.location !== null && !VALID_LOCATION.includes(body.location))
            return res.status(400).json({ error: 'invalid location' });
          updates.location = body.location; break;
        case 'feedback_rafa':
        case 'feedback_andrade':
        case 'ai_take':
          if (body[k] !== null && (typeof body[k] !== 'string' || body[k].length > 4000))
            return res.status(400).json({ error: `invalid ${k}` });
          updates[k] = body[k]; break;
        case 'due_date':
          if (body.due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(body.due_date))
            return res.status(400).json({ error: 'invalid due_date' });
          updates.due_date = body.due_date; break;
        case 'metadata':
          if (typeof body.metadata !== 'object' || Array.isArray(body.metadata))
            return res.status(400).json({ error: 'invalid metadata' });
          updates.metadata = body.metadata; break;
      }
    }
    if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'no updates' });
  }

  if (mode === 'rafa' && updates.status === 'done' && (updates.feedback_rafa || current.feedback_rafa)) {
    const fb = updates.feedback_rafa !== undefined ? updates.feedback_rafa : current.feedback_rafa;
    if (fb && fb.length >= 10) {
      const aiTake = await generateAiTake(current.title, current.description, fb);
      if (aiTake) updates.ai_take = aiTake;
    }
  }

  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/drope_tasks?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: sbHeaders({ Prefer: 'return=representation' }),
      body: JSON.stringify(updates),
    }
  );
  const patchedRows = await patchRes.json();
  if (!patchRes.ok) return res.status(502).json({ error: 'update failed', details: patchedRows });
  const updated = Array.isArray(patchedRows) ? patchedRows[0] : patchedRows;

  const notifs = [];
  const statusChanged = updates.status && updates.status !== current.status;
  if (statusChanged) {
    if ((updates.status === 'done' || updates.status === 'rejected') && ADMIN_LUCAS) {
      const lines = [
        `🔔 tarefa: ${updated.title}`, '',
        `status: ${current.status} → ${updates.status}`,
        updated.feedback_rafa ? `\nvisao do rafa:\n${updated.feedback_rafa.slice(0, 300)}` : '',
        updated.ai_take ? `\nopiniao da ia:\n${updated.ai_take.slice(0, 300)}` : '',
        '', `painel: https://drope-app.vercel.app/admin#tarefas`,
      ].filter(Boolean);
      notifs.push(await sendWhatsApp(ADMIN_LUCAS, lines.join('\n')));
    }
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
}

// ============ OP: CRON RELEASE EXPIRED ============
async function opCronRelease(req, res) {
  if (!CRON_TOKEN) return res.status(500).json({ error: 'CRON_TOKEN not configured' });
  const provided = bearerOr('x-cron-token', 'token', req);
  if (provided !== CRON_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const cutoff = new Date(Date.now() - EXPIRY_MINUTES * 60 * 1000).toISOString();
  const statusFilter = RESERVED_STATUSES.map(s => `"${s}"`).join(',');
  const listUrl =
    `${SUPABASE_URL}/rest/v1/drope_orders` +
    `?status=in.(${encodeURIComponent(statusFilter)})` +
    `&created_at=lt.${encodeURIComponent(cutoff)}` +
    `&select=order_nsu,status,items,created_at` +
    `&order=created_at.asc&limit=200`;

  const listRes = await fetch(listUrl, { headers: sbHeaders() });
  if (!listRes.ok) {
    const detail = await listRes.text();
    return res.status(502).json({ error: 'supabase list failed', details: detail });
  }
  const orders = await listRes.json();

  if (!Array.isArray(orders) || orders.length === 0) {
    return res.status(200).json({ ok: true, expired: 0, released: 0, cutoff, scanned: 0 });
  }

  let totalReleased = 0;
  const expiredOrders = [];

  for (const order of orders) {
    const items = Array.isArray(order.items) ? order.items : [];
    const releasable = items.filter(i => i && typeof i.slug === 'string' && typeof i.qty === 'number' && i.qty > 0);

    const releasedItems = [];
    for (const it of releasable) {
      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_release_stock`, {
          method: 'POST', headers: sbHeaders(),
          body: JSON.stringify({ p_slug: it.slug, p_qty: it.qty }),
        });
        if (r.ok) { releasedItems.push({ slug: it.slug, qty: it.qty }); totalReleased += it.qty; }
      } catch (e) { console.error('[tasks/cron-release] err:', e.message); }
    }

    try {
      const updRes = await fetch(
        `${SUPABASE_URL}/rest/v1/drope_orders?order_nsu=eq.${encodeURIComponent(order.order_nsu)}&status=in.(${encodeURIComponent(statusFilter)})`,
        {
          method: 'PATCH',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify({ status: 'expired' }),
        }
      );
      if (!updRes.ok) {
        for (const rel of releasedItems) {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/rpc/drope_consume_stock`, {
              method: 'POST', headers: sbHeaders(),
              body: JSON.stringify({ p_slug: rel.slug, p_qty: rel.qty }),
            });
          } catch (e) {}
        }
        continue;
      }
      expiredOrders.push({
        order_nsu: order.order_nsu,
        previous_status: order.status,
        released: releasedItems,
        age_minutes: Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000),
      });
    } catch (e) { console.error('[tasks/cron-release] mark err:', e.message); }
  }

  return res.status(200).json({
    ok: true, expired: expiredOrders.length, released: totalReleased,
    scanned: orders.length, cutoff, details: expiredOrders,
  });
}

// ============ OP: CRON DAILY SUMMARY ============
async function opCronDaily(req, res) {
  if (!CRON_TOKEN) return res.status(500).json({ error: 'CRON_TOKEN not configured' });
  const provided = bearerOr('x-cron-token', 'token', req);
  if (provided !== CRON_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  const url = `${SUPABASE_URL}/rest/v1/drope_tasks?status=in.("pending","in_progress","done","rejected")&select=assignee,status,priority,title,category&limit=500&order=created_at.desc`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) {
    const detail = await r.text();
    return res.status(502).json({ error: 'supabase error', details: detail });
  }
  const tasks = await r.json();

  const byAssignee = { andrade: 0, rafa: 0, code: 0 };
  const byStatus = { pending: 0, in_progress: 0, done: 0, rejected: 0 };
  const decisoesAbertas = [];
  const refazer = [];

  for (const t of tasks) {
    byAssignee[t.assignee] = (byAssignee[t.assignee] || 0) + 1;
    byStatus[t.status]     = (byStatus[t.status] || 0) + 1;
    if (t.assignee === 'andrade' && t.status === 'pending' &&
        (t.category === 'infra' || t.category === 'arquitetura' || /^DECIS[ÃA]O/i.test(t.title || ''))) {
      decisoesAbertas.push(t.title);
    }
    if (t.status === 'rejected') refazer.push(t.title);
  }

  const totalAtivas = byStatus.pending + byStatus.in_progress;
  const aguardando = byStatus.done;

  const lines = [
    `☀️ painel drope ✦ bom dia`, '',
    `${totalAtivas} ativas · ${aguardando} aguardando martelo${refazer.length ? ` · ${refazer.length} pra refazer` : ''}`,
    '', `por pessoa:`,
    `  andrade: ${byAssignee.andrade || 0}`,
    `  rafa: ${byAssignee.rafa || 0}`,
    `  code: ${byAssignee.code || 0}`,
  ];
  if (decisoesAbertas.length > 0) {
    lines.push('', `⚖️ decisões esperando voce (${decisoesAbertas.length}):`);
    for (const title of decisoesAbertas.slice(0, 5)) lines.push(`  • ${title.slice(0, 80)}`);
  }
  if (aguardando > 0) lines.push('', `✓ done aguardando aprovação: ${aguardando}`);
  lines.push('', `painel: https://drope-app.vercel.app/admin#tarefas`);

  const text = lines.join('\n');

  let sent = false;
  if (ADMIN_LUCAS && UAZAPI_TOKEN) {
    try {
      const sendRes = await fetch(`${UAZAPI_SERVER}/send/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', token: UAZAPI_TOKEN },
        body: JSON.stringify({ number: ADMIN_LUCAS, text }),
      });
      sent = sendRes.ok;
    } catch (e) { console.error('[tasks/cron-daily] send err:', e.message); }
  }

  return res.status(200).json({
    ok: true, sent,
    counts: { totalAtivas, aguardando, refazer: refazer.length, byAssignee, byStatus },
    decisoes_abertas: decisoesAbertas.length,
    preview: text,
  });
}

// ============ DISPATCHER ============
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  const op = req.query?.op || (req.body || {}).op || '';

  try {
    if (req.method === 'GET') return opList(req, res);

    if (req.method === 'POST') {
      switch (op) {
        case 'create':           return opCreate(req, res);
        case 'update':           return opUpdate(req, res);
        case 'cron-release':     return opCronRelease(req, res);
        case 'cron-daily':       return opCronDaily(req, res);
        default:
          return res.status(400).json({ error: `invalid op (got: ${op || 'none'})`, valid: ['create','update','cron-release','cron-daily'] });
      }
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('[tasks] ERROR:', err.message, err.stack);
    return res.status(500).json({ error: err.message });
  }
};
