// Drope — Tasks Create (cria nova tarefa no painel)
// POST /api/tasks-create
// Header obrigatório: x-admin-token: <ADMIN_TOKEN>   (só Andrade cria)
// Body JSON:
//   {
//     title: string (obrigatório, max 200),
//     description?: string (max 4000),
//     assignee: 'andrade' | 'rafa' | 'code' (obrigatório),
//     priority?: 'alta' | 'media' | 'baixa' (default 'media'),
//     category?: string,
//     location?: 'remoto' | 'presencial_andrade' | 'presencial_rafa' | 'loja' | 'qualquer',
//     due_date?: 'YYYY-MM-DD',
//     metadata?: object
//   }
//
// Side-effect: notifica WhatsApp do assignee (se RAFA_PHONE/ADMIN_LUCAS configurados).
//
// ENV VARS: SUPABASE_URL, SUPABASE_KEY, ADMIN_TOKEN
//           UAZAPI_SERVER, UAZAPI_TOKEN (pra notificação)
//           ADMIN_LUCAS, RAFA_PHONE (telefones com DDI, ex 5511962443565)

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "";
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN || "";
const UAZAPI_SERVER = process.env.UAZAPI_SERVER || "https://dropepod.uazapi.com";
const UAZAPI_TOKEN  = process.env.UAZAPI_TOKEN || "";
const ADMIN_LUCAS   = process.env.ADMIN_LUCAS || "";
const RAFA_PHONE    = process.env.RAFA_PHONE || "";

const VALID_ASSIGNEE = ['andrade','rafa','code'];
const VALID_PRIORITY = ['alta','media','baixa'];
const VALID_LOCATION = ['remoto','presencial_andrade','presencial_rafa','loja','qualquer'];

const PRIORITY_EMOJI = { alta: '🔴', media: '🟡', baixa: '🟢' };

function phoneFor(assignee) {
  if (assignee === 'rafa')    return RAFA_PHONE;
  if (assignee === 'andrade') return ADMIN_LUCAS;
  return null; // 'code' não recebe whats
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
    console.error('[tasks-create] whatsapp error:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  const allowedOrigins = ['https://drope-app.vercel.app', 'http://localhost:3000'];
  const origin = req.headers?.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  // 🔒 AUTH — só admin (Andrade) cria
  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
  const provided = req.headers['x-admin-token'] || '';
  if (provided !== ADMIN_TOKEN) {
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) return res.status(500).json({ error: 'supabase not configured' });

  try {
    const body = req.body || {};
    const { title, description, assignee, priority, category, location, due_date, metadata } = body;

    // 🔒 Validação
    if (!title || typeof title !== 'string' || title.length === 0 || title.length > 200) {
      return res.status(400).json({ error: 'invalid title (1-200 chars)' });
    }
    if (description !== undefined && (typeof description !== 'string' || description.length > 4000)) {
      return res.status(400).json({ error: 'invalid description (max 4000 chars)' });
    }
    if (!VALID_ASSIGNEE.includes(assignee)) {
      return res.status(400).json({ error: `invalid assignee (must be ${VALID_ASSIGNEE.join('|')})` });
    }
    const prio = priority || 'media';
    if (!VALID_PRIORITY.includes(prio)) {
      return res.status(400).json({ error: `invalid priority (must be ${VALID_PRIORITY.join('|')})` });
    }
    if (category !== undefined && (typeof category !== 'string' || category.length > 40 || !/^[a-z0-9_-]+$/i.test(category))) {
      return res.status(400).json({ error: 'invalid category' });
    }
    if (location !== undefined && location !== null && !VALID_LOCATION.includes(location)) {
      return res.status(400).json({ error: `invalid location (must be ${VALID_LOCATION.join('|')} or null)` });
    }
    if (due_date !== undefined && due_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      return res.status(400).json({ error: 'invalid due_date (must be YYYY-MM-DD)' });
    }
    if (metadata !== undefined && (typeof metadata !== 'object' || Array.isArray(metadata))) {
      return res.status(400).json({ error: 'invalid metadata (must be object)' });
    }

    const row = {
      title: title.trim().slice(0, 200),
      description: description ? description.trim().slice(0, 4000) : null,
      assignee,
      priority: prio,
      category: category || null,
      location: location || null,
      due_date: due_date || null,
      created_by: 'andrade',
      metadata: metadata || {},
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/drope_tasks`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[tasks-create] insert error:', r.status, data);
      return res.status(502).json({ error: 'insert failed', details: data });
    }
    const task = Array.isArray(data) ? data[0] : data;

    // 📲 Notificação WhatsApp do assignee
    let notif = { skipped: true };
    const phone = phoneFor(assignee);
    if (phone) {
      const emoji = PRIORITY_EMOJI[prio] || '';
      const link = `https://drope-app.vercel.app/admin#tarefas`;
      const lines = [
        `📋 nova tarefa ${emoji}`,
        ``,
        `*${task.title}*`,
        task.description ? task.description.slice(0, 200) + (task.description.length > 200 ? '...' : '') : null,
        ``,
        `prioridade: ${prio}`,
        `painel: ${link}`,
      ].filter(Boolean);
      notif = await sendWhatsApp(phone, lines.join('\n'));
    }

    return res.status(200).json({ ok: true, task, notif });

  } catch (err) {
    console.error('[tasks-create] ERROR:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
