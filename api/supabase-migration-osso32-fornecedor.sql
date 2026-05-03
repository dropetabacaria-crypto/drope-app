-- Drope — Migration OSSO 32: pipeline fornecedor via WhatsApp
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto:
--  1) sexta 23h BRT cron calcula reposição (produtos abaixo de qty_minima)
--     e salva snapshot
--  2) sábado 06h BRT bot manda "manda a lista de hoje" pros fornecedores
--  3) parser Haiku extrai itens da resposta, decisor cruza com snapshot
--  4) resumo vai pro Andrade no whats — APROVA fecha pedido, SEM aprova fica
--     em aguardando_aprovacao
--  5) bot NUNCA toca em Pix; Andrade paga manual

-- Reposição alvo (o que monitorar e em qual nível)
create table if not exists public.drope_reposicao_alvo (
    id           bigserial primary key,
    brand        text not null,
    model        text not null,
    flavor       text,
    qty_minima   int  not null default 5,    -- abaixo disso, entra na lista
    qty_alvo     int  not null default 15,   -- meta de estoque após reposição
    classe_abc   text not null default 'B'
                 check (classe_abc in ('A','B','C')),
    ativo        boolean not null default true,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now()
);

create unique index if not exists uq_reposicao_alvo
  on public.drope_reposicao_alvo (lower(brand), lower(model), lower(coalesce(flavor,'')));
create index if not exists idx_reposicao_alvo_ativo
  on public.drope_reposicao_alvo (ativo);

alter table public.drope_reposicao_alvo disable row level security;

-- Snapshot semanal do que precisa repor (gerado pelo cron sexta 23h)
create table if not exists public.drope_reposicao_snapshot (
    id           bigserial primary key,
    snapshot_at  timestamptz not null default now(),
    items        jsonb not null,             -- [{brand,model,flavor,qty_atual,qty_a_pedir,classe}]
    total_items  int not null default 0,
    consumed     boolean not null default false  -- vira true quando pedidos do sábado fecham
);

create index if not exists idx_reposicao_snapshot_at
  on public.drope_reposicao_snapshot (snapshot_at desc);

alter table public.drope_reposicao_snapshot disable row level security;

-- Pedidos negociados com fornecedor
create table if not exists public.drope_pedidos_fornecedor (
    id                bigserial primary key,
    snapshot_id       bigint references public.drope_reposicao_snapshot(id) on delete set null,
    fornecedor_phone  text not null,
    fornecedor_nome   text,
    status            text not null default 'aguardando_lista'
                      check (status in (
                        'aguardando_lista','lista_recebida','aguardando_aprovacao',
                        'aprovado','fechado','pago','recebido','cancelado'
                      )),
    lista_raw         text,                  -- texto/transcrição original do fornecedor
    lista_parsed      jsonb,                 -- [{brand,model,flavor,preco_cents,qty_disp}]
    proposta          jsonb,                 -- [{brand,model,flavor,acao,qty,preco_cents,alvo_cents}]
    valor_total_cents int,
    aprovado_at       timestamptz,
    fechado_at        timestamptz,
    pago_at           timestamptz,
    recebido_at       timestamptz,
    notes             text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
);

create index if not exists idx_pedidos_fornecedor_status
  on public.drope_pedidos_fornecedor (status);
create index if not exists idx_pedidos_fornecedor_phone
  on public.drope_pedidos_fornecedor (fornecedor_phone);
create index if not exists idx_pedidos_fornecedor_created
  on public.drope_pedidos_fornecedor (created_at desc);

alter table public.drope_pedidos_fornecedor disable row level security;

-- Histórico de preços por item (pra decisor saber preço-alvo histórico)
create table if not exists public.drope_precos_fornecedor_hist (
    id                bigserial primary key,
    fornecedor_phone  text not null,
    brand             text not null,
    model             text not null,
    flavor            text,
    preco_cents       int  not null,
    visto_em          timestamptz not null default now()
);

create index if not exists idx_precos_hist_lookup
  on public.drope_precos_fornecedor_hist (lower(brand), lower(model), lower(coalesce(flavor,'')), visto_em desc);

alter table public.drope_precos_fornecedor_hist disable row level security;

-- Validação
select table_name from information_schema.tables
where table_schema='public' and table_name like 'drope_%fornecedor%' or table_name like 'drope_reposicao_%'
order by table_name;
