-- Drope — Migration Osso 16: tabela de perdas/defeitos
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: PDV ganhou botão "marcar defeito" — operador bipa pod com defeito,
-- clica defeito → não vai pra carrinho, decrementa estoque, registra aqui.
-- Útil pra controle de perdas (negociar troca com fornecedor) e auditoria
-- (motivos de defeito mais comuns por marca/modelo).

create table if not exists public.drope_perdas (
    id            uuid primary key default gen_random_uuid(),
    product_id    bigint references public.drope_products(id) on delete set null,
    product_slug  text,
    product_name  text not null,
    barcode       text,
    operator      text,                                          -- 'pai' | 'yasmim' | 'mae' | 'raquel' | etc.
    motivo        text not null default 'defeito'
                  check (motivo in ('defeito', 'vencido', 'quebrado', 'devolucao', 'amostra', 'outro')),
    qty           int  not null default 1 check (qty > 0 and qty <= 50),
    notes         text,                                          -- observação livre (futuro)
    created_at    timestamptz not null default now()
);

create index if not exists idx_drope_perdas_created
  on public.drope_perdas (created_at desc);
create index if not exists idx_drope_perdas_product
  on public.drope_perdas (product_id);
create index if not exists idx_drope_perdas_motivo
  on public.drope_perdas (motivo);

alter table public.drope_perdas disable row level security;

-- Validação
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
  and table_name = 'drope_perdas'
order by ordinal_position;
