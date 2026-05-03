-- Drope — Migration Osso 12: Decremento de estoque "force" pro PDV
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: balcão precisa vender mesmo quando o sistema marca qty_available=0
-- (estoque físico ≠ digital, comum em loja real). A função padrão drope_consume_stock
-- bloqueia (return reason='out_of_stock'), o que é correto pra loja online mas
-- atrapalha o PDV. Esta fn nova decrementa SEMPRE — mesmo que vá pra negativo —
-- mantendo o lock atômico pra não quebrar o controle de race condition.
--
-- Quem usa:
--   - pdv-sale.js (balcão) → usa drope_consume_stock_force (esta)
--   - save-order.js (loja online) → continua usando drope_consume_stock (padrão)

create or replace function public.drope_consume_stock_force(p_slug text, p_qty int)
returns table(ok boolean, qty_after int, reason text) as $$
declare
    v_current int;
    v_hidden boolean;
begin
    -- LOCK row pra impedir race condition (mesmo padrão do drope_consume_stock)
    select qty_available, hidden into v_current, v_hidden
    from public.drope_products
    where slug = p_slug
    for update;

    if not found then
        return query select false, 0, 'product_not_found'::text;
        return;
    end if;

    -- Decrementa SEMPRE (vai pra negativo se preciso)
    update public.drope_products
    set qty_available = v_current - p_qty
    where slug = p_slug;

    return query select true, (v_current - p_qty), (
        case
            when v_current <= 0 then 'forced_negative'
            when v_current < p_qty then 'forced_partial'
            else 'ok'
        end
    )::text;
end;
$$ language plpgsql;

-- Validação rápida
select proname, pg_get_function_arguments(oid) as args
from pg_proc
where proname in ('drope_consume_stock', 'drope_consume_stock_force')
order by proname;
