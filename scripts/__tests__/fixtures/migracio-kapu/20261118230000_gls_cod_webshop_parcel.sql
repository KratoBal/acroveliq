-- A GLS cash-on-delivery line whose parcel is one the OS created for a WEBSHOP order. The parcel is
-- found through WebshopParcel (carrier, parcel number) to its order and the order's live outgoing
-- invoice, the Foxpost settlement's webshop lookup (#1996) on the GLS side. The GLS reference the UNAS
-- put on its parcels is an order key and the invoice number; a webshop parcel carries the order's
-- display id and the invoice number, and the parcel number is the one key both ends hold.
-- Additive: one enum value. No existing row changes.
-- ROLLBACK: an enum value cannot be dropped: lines with WEBSHOP_PARCEL must be re-resolved (or
--           set to MANUAL) first, then the type rebuilt without the value.

-- AlterEnum
ALTER TYPE "GlsCodResolutionSource" ADD VALUE 'WEBSHOP_PARCEL';
