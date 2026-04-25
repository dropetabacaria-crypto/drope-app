-- Drope — Migration Osso 8: Estoque + Reservas
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
-- Implementa controle de estoque transacional: cliente não consegue
-- comprar produto esgotado, e duas pessoas não conseguem comprar
-- a última unidade ao mesmo tempo (race condition).

-- ============================================================
-- 1. DROPE_PRODUCTS — catálogo central (substitui hardcoded no index.html)
-- ============================================================
create table if not exists public.drope_products (
    id              bigserial primary key,
    slug            text unique not null,           -- ex: 'elf-bar-bc-pro-mango-magic-45k'
    name            text not null,                  -- ex: 'Elf Bar BC Pro mango magic 45k'
    category        text,                           -- 'frutado' | 'mentolado' | 'gelado'
    price_cents     int not null,
    qty_available   int not null default 0,         -- 0 = esgotado, >0 disponível
    hidden          boolean not null default false, -- admin pode esconder sem deletar
    image_url       text,
    badge           text,                           -- 'favorito da noite' | 'top' | etc.
    metadata        jsonb default '{}'::jsonb,      -- info adicional flexível
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    constraint qty_non_negative check (qty_available >= 0)
);

create index if not exists idx_drope_products_slug     on public.drope_products(slug);
create index if not exists idx_drope_products_hidden   on public.drope_products(hidden);
create index if not exists idx_drope_products_category on public.drope_products(category);

-- Trigger: auto-update updated_at (reusa fn do osso 7)
drop trigger if exists drope_products_set_updated_at on public.drope_products;
create trigger drope_products_set_updated_at
    before update on public.drope_products
    for each row execute procedure public.drope_set_updated_at();

-- ============================================================
-- 2. FN: decrementa estoque atomicamente
-- Bloqueia o produto durante a transação pra evitar race condition.
-- Retorna NULL se sem estoque ou produto não existe.
-- ============================================================
create or replace function public.drope_consume_stock(p_slug text, p_qty int)
returns table(ok boolean, qty_after int, reason text) as $$
declare
    v_current int;
    v_hidden boolean;
begin
    -- LOCK row pra impedir double-spend simultâneo
    select qty_available, hidden into v_current, v_hidden
    from public.drope_products
    where slug = p_slug
    for update;

    if not found then
        return query select false, 0, 'product_not_found'::text;
        return;
    end if;

    if v_hidden then
        return query select false, v_current, 'product_hidden'::text;
        return;
    end if;

    if v_current < p_qty then
        return query select false, v_current, 'out_of_stock'::text;
        return;
    end if;

    update public.drope_products
       set qty_available = qty_available - p_qty
     where slug = p_slug;

    return query select true, v_current - p_qty, 'ok'::text;
end;
$$ language plpgsql;

-- ============================================================
-- 3. FN: devolve estoque (rollback de reserva, cancelamento de pedido)
-- ============================================================
create or replace function public.drope_release_stock(p_slug text, p_qty int)
returns void as $$
begin
    update public.drope_products
       set qty_available = qty_available + p_qty
     where slug = p_slug;
end;
$$ language plpgsql;

-- ============================================================
-- 4. RLS desabilitado (backend usa service key)
-- ============================================================
alter table public.drope_products disable row level security;

-- ============================================================
-- 5. SEED inicial — produtos atuais do catálogo Drope (placeholders)
-- Roda só se a tabela tá vazia. Andrade ajusta nomes/preços/qty depois.
-- ============================================================
insert into public.drope_products (slug, name, category, price_cents, qty_available, badge)
select * from (values
    ('black-sheep-blueberry-55k', 'Black Sheep blueberry 55k', 'frutado', 11000, 0, 'favorito da noite'),
    ('elf-bar-bc-pro-mango-magic-45k', 'Elf Bar BC Pro mango magic 45k', 'frutado', 11000, 0, null),
    ('elf-bar-ice-king-green-apple-40k', 'Elf Bar Ice King green apple 40k', 'frutado', 9500, 0, null),
    ('elf-bar-ice-king-miami-mint-40k', 'Elf Bar Ice King miami mint 40k', 'mentolado', 9500, 0, null),
    ('elf-bar-ice-king-double-apple-40k', 'Elf Bar Ice King double apple 40k', 'frutado', 9500, 0, null)
) as v(slug, name, category, price_cents, qty_available, badge)
where not exists (select 1 from public.drope_products limit 1);

-- ============================================================
-- Queries úteis pro admin:
-- ============================================================

-- Catálogo visível pro cliente:
-- select slug, name, category, price_cents/100.0 as preco, qty_available
-- from drope_products where hidden = false order by qty_available desc, name;

-- Repor estoque:
-- update drope_products set qty_available = qty_available + 10 where slug = 'black-sheep-blueberry-55k';

-- Esconder produto sem deletar:
-- update drope_products set hidden = true where slug = '...';

-- Top vendidos (cruzando com drope_orders.items):
-- select item->>'name' as produto, sum((item->>'qty')::int) as vendido
-- from drope_orders, jsonb_array_elements(items) as item
-- where status = 'paid' group by produto order by vendido desc limit 10;
