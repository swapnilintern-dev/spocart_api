// Shared zod fragments used by several routes.
import { z } from 'zod';

export const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const gstin = z.string().transform((s) => s.toUpperCase()).pipe(
  z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN'),
);
export const pincode = z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');
export const email = z.email('Enter a valid email address');
export const uuid = z.uuid('Invalid id');
export const businessType = z.enum(['retailer', 'wholesaler', 'academy', 'school', 'club', 'gym', 'corporate', 'other']);
