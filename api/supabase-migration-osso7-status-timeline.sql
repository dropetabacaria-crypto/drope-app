-- Drope — Migration Osso 7: Timeline de Status do Pedido
-- Cola no SQL Editor do Supabase (dashboard → SQL editor → New query)
-- IDEMPOTENTE — pode rodar várias vezes sem dar pau.
-- Só ADICIONA colunas/lógica, NÃO quebra nada existente.

-- ============================================================
-- 1. Adicionar colunas de timeline (nullable, default null)
-- ============================================================
alter table public.drope_orders
    add column if not exists prepared_at      timestamptz,
    add column if not exists dispatched_at    timestamptz,
    add column if not exists delivered_at     timestamptz,
    add column if not exists picked_up_at     timestamptz,    -- pra modo retirada
    add column if not exists status_history   jsonb not null default '[]'::jsonb,
    add column if not exists customer_track_token text;       -- token único pro cliente acompanhar pedido

-- ============================================================
-- 2. Estados válidos (documentação — não enforçado por enum pra flexibilidade)
-- ============================================================
-- Modo entrega:  'created' → 'paid' → 'preparing' → 'out_for_delivery' → 'delivered'
-- Modo retirada: 'created' → 'paid' → 'preparing' → 'ready_for_pickup' → 'picked_up'
-- Cancelado:     qualquer estado → 'cancelled'

-- ============================================================
-- 3. Trigger: registra histórico de mudança de status + atualiza timestamp do estágio
-- ============================================================
create or replace function public.drope_log_status_change()
returns trigger as $$
begin
    -- Se status mudou, registra no histórico e atualiza o timestamp correspondente
    if new.status is distinct from old.status then
        new.status_history = coalesce(old.status_history, '[]'::jsonb) || jsonb_build_object(
            'from', old.status,
            'to',   new.status,
            'at',   to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM-DD"T"HH24:MI:SS')
        );

        -- Atualiza timestamp do estágio
        if    new.status = 'preparing'        and new.prepared_at   is null then new.prepared_at   = now();
        elsif new.status = 'out_for_delivery' and new.dispatched_at is null then new.dispatched_at = now();
        elsif new.status = 'delivered'        and new.delivered_at  is null then new.delivered_at  = now();
        elsif new.status = 'ready_for_pickup' and new.dispatched_at is null then new.dispatched_at = now();
        elsif new.status = 'picked_up'        and new.picked_up_at  is null then new.picked_up_at  = now();
        end if;
    end if;
    return new;
end;
$$ language plpgsql;

drop trigger if exists drope_orders_log_status_change on public.drope_orders;
create trigger drope_orders_log_status_change
    before update on public.drope_orders
    for each row execute procedure public.drope_log_status_change();

-- ============================================================
-- 4. Backfill: pedidos antigos sem token recebem um agora
-- ============================================================
update public.drope_orders
   set customer_track_token = encode(gen_random_bytes(8), 'hex')
 where customer_track_token is null;

-- ============================================================
-- 5. Default novo: cada novo pedido nasce com track_token automático
-- ============================================================
alter table public.drope_orders
    alter column customer_track_token set default encode(gen_random_bytes(8), 'hex');

-- ============================================================
-- Queries úteis:
-- ============================================================

-- Ver pedido com timeline:
-- select order_nsu, status, status_history, created_at, payment_confirmed_at,
--        prepared_at, dispatched_at, delivered_at, picked_up_at
-- from drope_orders where order_nsu = 'drope-XXXXX';

-- Pedidos em andamento (não entregues, não cancelados):
-- select order_nsu, status, customer_snapshot->>'name' as cliente, total_cents/100.0 as total
-- from drope_orders
-- where status not in ('delivered', 'picked_up', 'cancelled')
-- order by created_at desc;

-- Avançar status manualmente (admin via Supabase Studio):
-- update drope_orders set status = 'preparing'        where order_nsu = 'drope-XXX';
-- update drope_orders set status = 'out_for_delivery' where order_nsu = 'drope-XXX';
-- update drope_orders set status = 'delivered'        where order_nsu = 'drope-XXX';
