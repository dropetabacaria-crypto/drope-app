-- Drope — Migration OSSO 33: ciclo briefing-sexta → autoriza → executa-sábado
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Fluxo:
--   sexta 18h  → cron friday_briefing INSERT (status='pending') + envia whats
--   andrade responde no whats → interpretAuthorizations gera autorizações JSONB
--                                e UPDATE (status='authorized')
--   sábado 10h → cron briefing_reminder pinga se ainda pending
--   sábado cedo (OSSO 32 dispatch) → executa pedidos autorizados, marca executed

create table if not exists public.drope_briefings (
    id              bigserial primary key,
    type            text not null default 'friday'
                    check (type in ('friday','adhoc')),
    status          text not null default 'pending'
                    check (status in ('pending','authorized','executed','skipped','expired')),
    content         text not null,                    -- mensagem que foi pro whats
    summary         jsonb,                            -- números brutos (vendas, top5, estoque, perdas)
    suggested       jsonb,                            -- propostas (pedidos sugeridos por produto)
    authorizations  jsonb,                            -- o que Andrade autorizou (extraído da resposta)
    response_raw    text,                             -- resposta literal do Andrade
    sent_at         timestamptz not null default now(),
    authorized_at   timestamptz,
    executed_at     timestamptz,
    reminder_sent_at timestamptz,
    created_at      timestamptz not null default now()
);

create index if not exists idx_briefings_status on public.drope_briefings (status);
create index if not exists idx_briefings_sent   on public.drope_briefings (sent_at desc);

alter table public.drope_briefings disable row level security;

-- Validação
select column_name, data_type from information_schema.columns
where table_schema='public' and table_name='drope_briefings'
order by ordinal_position;
