-- Drope — Migration Osso 20: coluna source em drope_customers (FEATURE 3 — captura silenciosa)
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: o webhook.js (captureCustomerSilent) e o save-order.js agora marcam de onde
-- o cliente veio: 'whatsapp' (bot), 'app' (checkout) ou 'pdv' (balcão futuro).
-- Útil pra Feature 4 (painel admin-customers) e relatórios de origem.
--
-- O backend já está tolerante: se rodar sem essa migration, ele usa fallback (INSERT sem source).
-- Rodar essa migration ATIVA o tracking de origem retroativamente pra novos registros.

alter table public.drope_customers
  add column if not exists source text default 'unknown';

-- Constraint check pra valores conhecidos (não bloqueia 'unknown' como default)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drope_customers_source_check'
  ) then
    alter table public.drope_customers
      add constraint drope_customers_source_check
      check (source in ('whatsapp', 'app', 'pdv', 'admin', 'unknown'));
  end if;
end$$;

-- Index pra queries do painel ("clientes do app", "clientes do bot")
create index if not exists idx_drope_customers_source on public.drope_customers(source);

-- Validação
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'drope_customers'
  and column_name = 'source';
