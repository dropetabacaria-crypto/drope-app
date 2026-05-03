-- Drope — Migration Osso 14: coluna metadata em drope_orders
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: pdv-sale.js (Fase 1.3) tenta gravar metadata.has_unregistered=true
-- pra marcar vendas que tiveram produto não cadastrado. A coluna não existia →
-- INSERT falhava com "Could not find metadata column of drope_orders".
-- Esta migration adiciona a coluna idempotente. Útil pra futuras queries de
-- relatório (ex: "qual % das vendas no PDV teve produto não cadastrado?").

alter table public.drope_orders
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- Índice GIN pra queries que filtrem por chaves do metadata (ex: has_unregistered)
create index if not exists idx_drope_orders_metadata_gin
  on public.drope_orders using gin (metadata);

-- Validação
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'drope_orders'
  and column_name = 'metadata';
