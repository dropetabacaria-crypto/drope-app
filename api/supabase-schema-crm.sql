-- Drope CRM Schema — Supabase
-- Cola no SQL Editor do Supabase (dashboard.supabase.com → SQL editor → New query)
-- Rode uma vez. É idempotente (pode rodar de novo sem problemas).
-- Tabelas com prefixo "drope_" pra evitar conflito com outros experimentos.

-- ============================================================
-- DROPE_CUSTOMERS — base única de clientes (dedup por telefone)
-- ============================================================
create table if not exists public.drope_customers (
    id             bigserial primary key,
    phone          text unique not null,
    name           text,
    email          text,
    created_at     timestamptz not null default now(),
    last_seen_at   timestamptz not null default now(),
    total_orders   int not null default 0,
    total_spent_cents bigint not null default 0,
    notes          text
);

create index if not exists idx_drope_customers_phone on public.drope_customers(phone);
create index if not exists idx_drope_customers_email on public.drope_customers(email);

-- ============================================================
-- DROPE_ORDERS — cada pedido feito no app
-- ============================================================
create table if not exists public.drope_orders (
    id                      bigserial primary key,
    order_nsu               text unique not null,
    customer_id             bigint references public.drope_customers(id) on delete set null,
    customer_snapshot       jsonb,
    status                  text not null default 'waiting_proof',
    payment_method          text not null,
    transaction_id          text,
    amount_paid_cents       bigint,
    payment_confirmed_at    timestamptz,
    subtotal_cents          bigint not null,
    delivery_fee_cents      bigint not null default 0,
    total_cents             bigint not null,
    items                   jsonb not null,
    delivery_mode           text,
    address                 jsonb,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index if not exists idx_drope_orders_customer_id  on public.drope_orders(customer_id);
create index if not exists idx_drope_orders_status       on public.drope_orders(status);
create index if not exists idx_drope_orders_created_at   on public.drope_orders(created_at desc);
create index if not exists idx_drope_orders_order_nsu    on public.drope_orders(order_nsu);

-- ============================================================
-- Trigger: atualiza updated_at automaticamente
-- ============================================================
create or replace function public.drope_set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists drope_orders_set_updated_at on public.drope_orders;
create trigger drope_orders_set_updated_at
    before update on public.drope_orders
    for each row execute procedure public.drope_set_updated_at();

-- ============================================================
-- Trigger: incrementa total_orders/spent do cliente quando pedido é PAGO
-- ============================================================
create or replace function public.drope_bump_customer_stats()
returns trigger as $$
begin
    if new.status = 'paid' and (old.status is null or old.status <> 'paid') then
        if new.customer_id is not null then
            update public.drope_customers
               set total_orders     = total_orders + 1,
                   total_spent_cents = total_spent_cents + coalesce(new.amount_paid_cents, new.total_cents),
                   last_seen_at     = now()
             where id = new.customer_id;
        end if;
    end if;
    return new;
end;
$$ language plpgsql;

drop trigger if exists drope_orders_bump_customer_stats on public.drope_orders;
create trigger drope_orders_bump_customer_stats
    after insert or update on public.drope_orders
    for each row execute procedure public.drope_bump_customer_stats();

-- ============================================================
-- RLS desabilitado (backend usa chave de serviço direto)
-- ============================================================
alter table public.drope_customers disable row level security;
alter table public.drope_orders    disable row level security;

-- ============================================================
-- Queries úteis pro admin dashboard:
-- ============================================================

-- Pedidos de hoje:
-- select * from drope_orders where created_at::date = current_date order by created_at desc;

-- Top 10 clientes:
-- select id, name, phone, total_orders, total_spent_cents / 100.0 as total_reais
-- from drope_customers order by total_spent_cents desc limit 10;

-- Receita de hoje:
-- select sum(amount_paid_cents) / 100.0 as receita_hoje
-- from drope_orders where status = 'paid' and payment_confirmed_at::date = current_date;
