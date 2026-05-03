-- Drope — Migration Osso 13: Regra de preço por marca+modelo
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: cadastro via WhatsApp pergunta o preço UMA vez por (marca, modelo).
-- Todos os sabores do mesmo modelo herdam o mesmo preço (prática real do balcão).
-- Ex: define R$ 110 pra "Black Sheep Cyber Tank Pro 55K" → todos os sabores
-- (Cool Mint, Blueberry, Grape, etc) entram com R$ 110 sem perguntar de novo.

create table if not exists public.drope_price_rules (
    id              uuid primary key default gen_random_uuid(),
    brand           text not null,
    model           text not null,
    price_cents     int  not null check (price_cents > 0 and price_cents <= 10000000),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- Unicidade case-insensitive por (brand, model). Postgres exige UNIQUE INDEX
-- (não UNIQUE constraint) quando expressões como lower() entram em jogo.
create unique index if not exists drope_price_rules_brand_model_uniq
    on public.drope_price_rules (lower(brand), lower(model));

-- Índice de lookup principal (mesmo case-insensitive)
create index if not exists drope_price_rules_lookup_idx
    on public.drope_price_rules (lower(brand), lower(model));

-- Trigger updated_at automático (reusa fn do osso10)
do $$
begin
  if exists (select 1 from pg_proc where proname = 'drope_set_updated_at') then
    drop trigger if exists drope_price_rules_set_updated_at on public.drope_price_rules;
    create trigger drope_price_rules_set_updated_at
      before update on public.drope_price_rules
      for each row execute procedure public.drope_set_updated_at();
  end if;
end $$;

-- Backend usa service_role (bypass RLS) — desabilita RLS pra simplicidade
alter table public.drope_price_rules disable row level security;

-- Validação rápida
select
  c.column_name,
  c.data_type,
  c.is_nullable,
  c.column_default
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name   = 'drope_price_rules'
order by c.ordinal_position;
