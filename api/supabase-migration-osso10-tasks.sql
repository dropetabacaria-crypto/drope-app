-- Drope — Migration Osso 10: Painel de Tarefas Andrade↔Rafa↔Code
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
-- Implementa drope_tasks: fila compartilhada de tarefas + decisões do projeto.
--
-- Modelo de permissão (enforçado nos endpoints API, não no banco):
--   andrade  → cria, atribui, muda status, aprova, rejeita, comenta tudo
--   rafa     → vê só as próprias; pode mudar status (pending→in_progress→done)
--              e escrever feedback_rafa. NÃO cria, NÃO aprova, NÃO mexe nas dos outros.
--   code     → tarefas executadas pela IA Claude Code; status visível pra Andrade.
--
-- Fluxo padrão:
--   pending → in_progress → done → approved   (caminho feliz)
--                              ↘ rejected     (refazer com feedback_andrade)
--                                cancelled    (Andrade cancelou)

-- ============================================================
-- 0. Função utilitária — set updated_at automático (idempotente)
-- ============================================================
create or replace function public.drope_set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

-- ============================================================
-- 1. DROPE_TASKS — fila compartilhada
-- ============================================================
create table if not exists public.drope_tasks (
    id                uuid primary key default gen_random_uuid(),
    title             text not null,
    description       text,
    assignee          text not null check (assignee in ('andrade', 'rafa', 'code')),
    status            text not null default 'pending'
                      check (status in ('pending', 'in_progress', 'done', 'approved', 'rejected', 'cancelled')),
    priority          text not null default 'media'
                      check (priority in ('alta', 'media', 'baixa')),
    category          text,                                -- 'estoque' | 'bot' | 'infra' | 'inteligencia' | 'arquitetura' | 'admin' | etc.
    location          text check (location is null or location in ('remoto', 'presencial_andrade', 'presencial_rafa', 'loja', 'qualquer')),
    feedback_rafa     text,                                -- visão do Rafa (texto livre escrito por ele)
    feedback_andrade  text,                                -- resposta/decisão do Andrade
    ai_take           text,                                -- resumo curado + opinião da IA pro Andrade
    approved_by       text,                                -- 'andrade' (único quem aprova)
    approved_at       timestamptz,
    due_date          date,
    created_by        text not null default 'system',      -- 'andrade' | 'system' | 'cowork' | 'code'
    metadata          jsonb not null default '{}'::jsonb,  -- ponte_ref, decisao_ref, files, options, etc.
    -- TODO[multi-tenant]: store_id text quando Plataforma sair do dormindo
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    completed_at      timestamptz                          -- preenchido quando vai pra approved/rejected/cancelled
);

create index if not exists idx_drope_tasks_assignee_status on public.drope_tasks(assignee, status);
create index if not exists idx_drope_tasks_status          on public.drope_tasks(status);
create index if not exists idx_drope_tasks_priority        on public.drope_tasks(priority);
create index if not exists idx_drope_tasks_created_at      on public.drope_tasks(created_at desc);

-- ============================================================
-- 2. Trigger: updated_at automático
-- ============================================================
drop trigger if exists drope_tasks_set_updated_at on public.drope_tasks;
create trigger drope_tasks_set_updated_at
    before update on public.drope_tasks
    for each row execute procedure public.drope_set_updated_at();

-- ============================================================
-- 3. Trigger: completion timestamps (approved/rejected/cancelled)
-- ============================================================
create or replace function public.drope_tasks_log_completion()
returns trigger as $$
begin
    if new.status is distinct from old.status then
        if new.status in ('approved', 'rejected', 'cancelled') and new.completed_at is null then
            new.completed_at = now();
        end if;
        if new.status = 'approved' and new.approved_at is null then
            new.approved_at = now();
        end if;
    end if;
    return new;
end;
$$ language plpgsql;

drop trigger if exists drope_tasks_log_completion on public.drope_tasks;
create trigger drope_tasks_log_completion
    before update on public.drope_tasks
    for each row execute procedure public.drope_tasks_log_completion();

-- ============================================================
-- 4. RLS desabilitado (backend usa service key, igual drope_products/drope_orders)
-- ============================================================
alter table public.drope_tasks disable row level security;

-- ============================================================
-- 5. SEED inicial — 7 tarefas pendentes da PONTE + 2 decisões abertas
-- Roda só se a tabela tá vazia (idempotente).
-- ============================================================
insert into public.drope_tasks (title, description, assignee, status, priority, category, created_by, metadata)
select * from (values
    -- ===== Tarefas Code (técnico) =====
    ('Estoque: alerta WhatsApp quando qty_available <= 3',
     'Quando o decremento em save-order.js (drope_consume_stock) deixa qty_after <= 3, notificar Lucas via UazAPI. Mensagem: "⚠️ estoque baixo: <produto> ficou com X unidade(s)". Cooldown: 1 alerta por slug por hora pra não spammar.',
     'code', 'pending', 'alta', 'estoque', 'system',
     '{"ponte_ref":"TAREFA 1.2","files":["save-order.js"]}'::jsonb),

    ('Estoque: badge "esgotado" + botão desabilitado no index.html',
     'Front (index.html, ~361KB): quando produto vier do check-stock com qty_available=0, mostrar badge vermelho "esgotado" e desabilitar botão de compra. Verificar primeiro se já existe lógica condicional — se sim, só ajustar visual.',
     'code', 'pending', 'alta', 'estoque', 'system',
     '{"ponte_ref":"TAREFA 1.3","files":["index.html"]}'::jsonb),

    ('Estoque: confirmar visual "qty baixo" no admin.html',
     'admin.html já mostra estoque na aba Stock (renderStock) com cor laranja se <5 e vermelho se 0. Verificar se basta ou se precisa ajuste. Se ok, fechar como done.',
     'code', 'pending', 'baixa', 'estoque', 'system',
     '{"ponte_ref":"TAREFA 1.4","files":["admin.html"]}'::jsonb),

    ('Bot follow-up pós-venda 24h após delivered/picked_up',
     'Cron 1x/hora: query drope_orders com status delivered/picked_up cujo delivered_at/picked_up_at é entre 23-25h atrás E não tem flag metadata.followup_sent. Manda mensagem ao cliente: "e aí, curtiu o [produto]? qualquer coisa manda aqui que a gente resolve 🦎". Marca followup_sent=true. Depende da Decisão "onde rodar crons".',
     'code', 'pending', 'media', 'bot', 'system',
     '{"ponte_ref":"TAREFA 2","files":["new: cron-followup-24h.js"],"depends_on":"DECISAO 2"}'::jsonb),

    ('Bot recompra automática 15 dias após última compra',
     'Cron 1x/dia (10h SP): clientes em drope_customers com última compra entre 14-16 dias atrás, sem nova compra. Manda lembrete via UazAPI: "faz 15 dias que você dropou [produto]. bora de novo? [link]". Janela 10-20h, máximo 1 lembrete por ciclo (flag em metadata).',
     'code', 'pending', 'media', 'bot', 'system',
     '{"ponte_ref":"TAREFA 3","files":["new: cron-recompra-15d.js"],"depends_on":"DECISAO 2"}'::jsonb),

    ('Bot catálogo consultável (busca fuzzy via WhatsApp)',
     'Em webhook.js, antes de cair no Claude Haiku do cliente, detectar intent ("catalogo"/"cardapio"/"quero ver"/nomes de sabores). Match → query drope_products via ilike, retorna top 10 com preço. Sem match → "não achei, mas dá uma olhada no app: [link]". Nunca vende pelo whats — sempre direciona pro app.',
     'code', 'pending', 'media', 'bot', 'system',
     '{"ponte_ref":"TAREFA 4","files":["webhook.js"]}'::jsonb),

    ('Varredura de concorrência local Vila Prudente/SP',
     'Pesquisar 10+ tabacarias da região com canal de venda online. Coletar: nome, site/instagram, faixa de preço, delivery, app, diferencial. Salvar em inteligencia/concorrencia-local-v1.md em formato tabela. Inclui top 5 produtos mais vendidos de cada se possível.',
     'code', 'pending', 'baixa', 'inteligencia', 'system',
     '{"ponte_ref":"TAREFA 5","files":["new: inteligencia/concorrencia-local-v1.md"]}'::jsonb),

    -- ===== Decisões Andrade =====
    ('DECISÃO: onde rodar os crons agendados',
     'Tem 3 crons pendentes: (1) expiry de reservas a cada 5-10min [já tem endpoint], (2) follow-up pós-venda 1x/h, (3) recompra 1x/dia. Opções: (A) Vercel Cron Hobby — limita 2 crons + freq diária, NÃO resolve expiry. (A2) Vercel Cron Pro $20/mês — resolve tudo, custa. (B) cron-job.org externo — free, 3 jobs, granularidade total. (C) Supabase pg_cron híbrido — mais complexo. RECOMENDAÇÃO CODE: (B) cron-job.org. Bloqueia tarefas #2 e #3 acima.',
     'andrade', 'pending', 'alta', 'infra', 'system',
     '{"decisao_ref":"DECISAO 2","options":["A","A2","B","C"],"code_recommends":"B"}'::jsonb),

    ('DECISÃO: multi-tenant agora ou depois',
     'PONTE pediu "pensar multi-tenant desde já". ECOSSISTEMA diz Plataforma DORMINDO até 50+ clientes/semana. Refatorar agora pra multi-tenant é semanas. RECOMENDAÇÃO CODE: adiar — adicionar // TODO[multi-tenant] em cada query/endpoint que precisaria de store_id, pra refatoração futura ser cirúrgica em vez de big-bang.',
     'andrade', 'pending', 'media', 'arquitetura', 'system',
     '{"decisao_ref":"DECISAO 3","code_recommends":"adiar com TODO comments"}'::jsonb)
) as v(title, description, assignee, status, priority, category, created_by, metadata)
where not exists (select 1 from public.drope_tasks limit 1);

-- ============================================================
-- Queries úteis
-- ============================================================

-- Painel do Andrade (tudo, ordenado por prioridade + data):
-- select id, title, assignee, status, priority, created_at
-- from drope_tasks
-- where status not in ('approved','cancelled')
-- order by case priority when 'alta' then 1 when 'media' then 2 else 3 end, created_at desc;

-- Painel do Rafa (só dele, ativas):
-- select id, title, status, priority, description, feedback_rafa
-- from drope_tasks
-- where assignee = 'rafa' and status in ('pending','in_progress','done')
-- order by case priority when 'alta' then 1 when 'media' then 2 else 3 end, created_at desc;

-- Decisões abertas pro Andrade:
-- select id, title, description, metadata
-- from drope_tasks
-- where assignee = 'andrade' and status = 'pending' and category in ('infra','arquitetura')
-- order by case priority when 'alta' then 1 when 'media' then 2 else 3 end;

-- Resumo do dia (pro ping diário 9h):
-- select assignee, status, count(*) as n
-- from drope_tasks
-- where status in ('pending','in_progress','done')
-- group by assignee, status;
