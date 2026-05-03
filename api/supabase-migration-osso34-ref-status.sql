-- Drope — Migration OSSO 34: ref_status em drope_products
-- Cola no SQL Editor do Supabase. IDEMPOTENTE.
--
-- Contexto: pipeline de referência visual em 3 camadas (auto/da-caixa/manual).
-- ref_status separa o estado da REFERÊNCIA (foto do dispositivo real) do
-- image_status (estado da ARTE gerada pelo Grok).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='drope_products' AND column_name='ref_status'
  ) THEN
    ALTER TABLE public.drope_products
      ADD COLUMN ref_status text DEFAULT 'none';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='drope_products_ref_status_check'
  ) THEN
    ALTER TABLE public.drope_products
      ADD CONSTRAINT drope_products_ref_status_check
      CHECK (ref_status IN ('none','auto_found','auto_failed','manual_uploaded','from_box'));
  END IF;
END
$$;

-- Index parcial pra query do admin (só pendentes)
CREATE INDEX IF NOT EXISTS drope_products_ref_status_idx
  ON public.drope_products (ref_status)
  WHERE ref_status IN ('none','auto_failed');

-- Backfill: produtos com reference_image_url já preenchido viram auto_found
UPDATE public.drope_products
   SET ref_status = 'auto_found'
 WHERE reference_image_url IS NOT NULL
   AND reference_image_url <> ''
   AND ref_status = 'none';

-- Produtos com box_photo_url mas sem reference_image_url viram from_box
UPDATE public.drope_products
   SET ref_status = 'from_box'
 WHERE box_photo_url IS NOT NULL
   AND box_photo_url <> ''
   AND (reference_image_url IS NULL OR reference_image_url = '')
   AND ref_status = 'none';

-- Verificação
SELECT ref_status, count(*) FROM public.drope_products
 GROUP BY ref_status ORDER BY ref_status;
