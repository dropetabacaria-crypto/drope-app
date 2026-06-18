-- OSSO 35 — Balanço por câmera: reconciliação + commit no estoque real.
-- Enriquece drope_balancos pra guardar o resultado do commit (não só os totais).
-- Idempotente: roda quantas vezes quiser. Cola no Supabase SQL Editor.

-- Garante a tabela base (caso esteja num projeto novo).
create table if not exists public.drope_balancos (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finalized_at  timestamptz not null default now(),
  total_counted int not null default 0,
  total_system  int not null default 0,
  diff_total    int not null default 0,
  unknown_count int not null default 0,
  counts        jsonb not null default '[]'::jsonb,
  unknown       jsonb not null default '{}'::jsonb,
  created_by    text,
  created_at    timestamptz not null default now()
);

-- Colunas novas do commit (situações 1-9 do OSSO 35).
alter table public.drope_balancos add column if not exists vendavel_un       int     not null default 0;  -- unidades vendáveis após reconciliar
alter table public.drope_balancos add column if not exists vendavel_skus     int     not null default 0;  -- sabores distintos com estoque
alter table public.drope_balancos add column if not exists divergencias      jsonb   not null default '[]'::jsonb; -- [{slug,nome,sistema,contado,diff,reservado,valor_cents}]
alter table public.drope_balancos add column if not exists perda_total_cents int     not null default 0;  -- R$ estimado sumindo nas faltas
alter table public.drope_balancos add column if not exists escondidos        int     not null default 0;  -- não-escaneados zerados + ocultados (situação 4)
alter table public.drope_balancos add column if not exists perdas_count      int     not null default 0;  -- itens lançados em drope_perdas (situação 6)
alter table public.drope_balancos add column if not exists achados_count     int     not null default 0;  -- produtos novos criados (situação 5)
alter table public.drope_balancos add column if not exists committed         boolean not null default false; -- true = mexeu no estoque (commit); false = só registro/histórico
alter table public.drope_balancos add column if not exists raw               jsonb;  -- payload completo da sessão p/ auditoria

create index if not exists idx_drope_balancos_finalized
  on public.drope_balancos (finalized_at desc);

-- RLS off (mesmo padrão das outras tabelas internas do Drope).
alter table public.drope_balancos disable row level security;
