// Drope — Tasks List (lista tarefas do painel drope_tasks)
// GET /api/tasks-list
//
// AUTH (dois modos):
//   Andrade: header x-admin-token: <ADMIN_TOKEN>     → vê TUDO
//   Rafa:    header x-rafa-token:  <RAFA_TOKEN>      → vê SÓ tarefas dele (assignee='rafa')
//
// Query params (opcionais):
//   ?assignee=andrade,rafa,code  (ignorado em modo Rafa — sempre 'rafa')
//   ?status=pending,in_progress,done,approved,rejected,cancelled
//   ?priority=alta,media,baixa
//   ?category=estoque,bot,...
//   ?limit=200 (max 500)
//   ?include_completed=true   (default false → esconde approved/cancelled)
//
// Retorna:
//   { ok, mode, tasks, counts: { by_assignee, by_status, by_priority, total } }
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN, RAFA_TOKEN

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const RAFA_TOKEN   = process.env.RAFA_TOKEN || "";

const VALID_STATUS = ['pending','in_progress','done','approved','rejected','cancelled'];
const VALID_PRIORITY = ['alta','media','baixa'];
const VALID_ASSIGNEE = ['andrade','rafa','code'];

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-rafa-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

  // 🔒 AUTH dual: admin OU rafa
  const adminProvided = req.headers['x-admin-token'] || '';
  const rafaProvided  = req.headers['x-rafa-token']  || '';
  let mode = null;
  if (ADMIN_TOKEN && adminProvided && adminProvided === ADMIN_TOKEN) mode = 'admin';
  else if (RAFA_TOKEN && rafaProvided && rafaProvided === RAFA_TOKEN) mode = 'rafa';

  if (!mode) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'supabase not configured' });
  }

  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query?.limit || '200', 10) || 200));
    const includeCompleted = String(req.query?.include_completed || '').toLowerCase() === 'true';

    // Modo Rafa: força assignee=rafa, ignora outras opções
    let assigneeList;
    if (mode === 'rafa') {
      assigneeList = ['rafa'];
    } else {
      const aParam = req.query?.assignee || '';
      assigneeList = aParam
        ? String(aParam).split(',').map(s => s.trim()).filter(s => VALID_ASSIGNEE.includes(s))
        : [];
    }

    const sParam = req.query?.status || '';
    const statusList = sParam
      ? String(sParam).split(',').map(s => s.trim()).filter(s => VALID_STATUS.includes(s))
      : [];

    const pParam = req.query?.priority || '';
    const priorityList = pParam
      ? String(pParam).split(',').map(s => s.trim()).filter(s => VALID_PRIORITY.includes(s))
      : [];

    const categoryParam = req.query?.category || '';
    const categoryList = categoryParam
      ? String(categoryParam).split(',').map(s => s.trim()).filter(s => /^[a-z0-9_-]{1,40}$/i.test(s))
      : [];

    // Monta filtros PostgREST
    const parts = ['select=*', `limit=${limit}`, 'order=created_at.desc'];
    if (assigneeList.length) parts.push(`assignee=in.(${assigneeList.map(s => `"${s}"`).join(',')})`);
    if (statusList.length)   parts.push(`status=in.(${statusList.map(s => `"${s}"`).join(',')})`);
    if (priorityList.length) parts.push(`priority=in.(${priorityList.map(s => `"${s}"`).join(',')})`);
    if (categoryList.length) parts.push(`category=in.(${categoryList.map(s => `"${s}"`).join(',')})`);
    if (!includeCompleted && !statusList.length) {
      parts.push(`status=in.("pending","in_progress","done","rejected")`);
    }

    const url = `${SUPABASE_URL}/rest/v1/drope_tasks?${parts.join('&')}`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const rows = await r.json();
    if (!r.ok) {
      console.error('[tasks-list] supabase error:', r.status, rows);
      return res.status(502).json({ error: 'supabase error', details: rows });
    }

    // Em modo Rafa, oculta campos sensíveis (feedback_andrade interno)
    const tasks = mode === 'rafa'
      ? rows.map(t => {
          const { feedback_andrade, approved_by, approved_at, ...safe } = t;
          return safe;
        })
      : rows;

    // Counts
    const counts = {
      total: rows.length,
      by_status: {},
      by_priority: {},
      by_assignee: {},
    };
    for (const t of rows) {
      counts.by_status[t.status]     = (counts.by_status[t.status] || 0) + 1;
      counts.by_priority[t.priority] = (counts.by_priority[t.priority] || 0) + 1;
      counts.by_assignee[t.assignee] = (counts.by_assignee[t.assignee] || 0) + 1;
    }

    return res.status(200).json({ ok: true, mode, tasks, counts });

  } catch (err) {
    console.error('[tasks-list] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
