-- Drope — Migration OSSO 31: corridas de motoboy via grupo WhatsApp
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: pedido pago dispara cartão de corrida no grupo "Drope Motoboys".
-- Primeiro motoboy que responde "PEGO" (lock atômico) ganha. Andrade vê tudo
-- numa dashboard. Bot NUNCA cancela ninguém sem perguntar.

create table if not exists public.drope_corridas (
    id              bigserial primary key,
    order_id        bigint references public.drope_orders(id) on delete set null,
    status          text not null default 'aberta'
                    check (status in ('aberta','aceita','entregue','cancelada')),
    motoboy_phone   text,
    motoboy_nome    text,
    valor_motoboy_cents int,
    msg_group_id    text,                              -- id da msg postada no grupo (pra editar depois)
    posted_at       timestamptz not null default now(),
    accepted_at     timestamptz,
    delivered_at    timestamptz,
    cancel_reason   text,
    metadata        jsonb default '{}'::jsonb,
    updated_at      timestamptz not null default now()
);

create index if not exists idx_drope_corridas_status on public.drope_corridas (status);
create index if not exists idx_drope_corridas_order  on public.drope_corridas (order_id);
create index if not exists idx_drope_corridas_posted on public.drope_corridas (posted_at desc);

alter table public.drope_corridas disable row level security;

-- Lock atômico pra "primeiro a aceitar pega". Retorna a corrida se conseguiu;
-- 0 rows se outro motoboy ganhou primeiro (fail-soft no caller).
create or replace function public.drope_aceitar_corrida(
  p_corrida_id bigint, p_phone text, p_nome text
) returns setof public.drope_corridas as $$
  update public.drope_corridas
     set status='aceita', motoboy_phone=p_phone, motoboy_nome=p_nome,
         accepted_at=now(), updated_at=now()
   where id=p_corrida_id and status='aberta'
  returning *;
$$ language sql;

-- Validação
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema='public' and table_name='drope_corridas'
order by ordinal_position;
