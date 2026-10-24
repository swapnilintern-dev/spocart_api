// Shared zod fragments used by several routes.
import { z } from 'zod';

export const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number');
export const gstin = z.string().transform((s) => s.toUpperCase()).pipe(
  z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Enter a valid GSTIN'),
);
export const pincode = z.string().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');
export const email = z.email('Enter a valid email address');
export const uuid = z.uuid('Invalid id');
/**
 * Free text a person types (names, addresses, messages). Anything tag-like —
 * "<" followed by a letter, "/", "!" or "?" — is refused, so a public form can
 * never carry markup into the admin panel. A bare "<" as in "<50 pcs" is fine.
 */
const TAG_LIKE = /<\s*[a-z!/?]/i;
export const plainText = (max, min = 0, required = 'This field is required') => z.string()
  .trim()
  .min(min, required)
  .max(max, `Please keep this under ${max} characters`)
  .refine((v) => !TAG_LIKE.test(v), 'Please remove the < > characters from this field');

/** A file link we can safely put in an href: our own upload path or http(s). */
export const fileUrl = z.string().trim().max(2048)
  .refine((v) => /^https?:\/\//i.test(v) || v.startsWith('/uploads/'), 'Invalid file link');

export const businessType =z.enum(['retailer', 'wholesaler', 'academy', 'school', 'club', 'gym', 'corporate', 'other']);
