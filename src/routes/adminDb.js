// Admin database console: list / read / create / update / delete for every
// table, behind requireAuth + requireAdmin (mounted from admin.js).
// Each table declares which columns are searchable, which are editable (with a
// zod schema), which BigInt columns are money (paise ↔ rupees) and how deletes
// are guarded so relations never break.
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { asyncHandler, ApiError } from '../middleware/error.js';
import { ok } from '../utils/respond.js';
import { validateTiers } from '../services/pricing.js';
import { mobile, gstin, pincode, email, businessType } from './_schemas.js';

const money = z.number().min(0);                       // rupees in / out
const slug = z.string().regex(/^[a-z0-9-]+$/, 'Use a slug like ck-kashmir-willow-bat');
const dateish = z.string().min(4);

/** Table registry. `fields` drives both validation and the admin form. */
const TABLES = {
  categories: {
    model: 'category', label: 'Categories', id: 'id', search: ['id', 'name'], order: { sortOrder: 'asc' },
    fields: {
      id: { type: 'text', schema: slug, create: true, key: true },
      name: { type: 'text', schema: z.string().min(1) },
      icon: { type: 'text', schema: z.string().min(1), hint: 'Material icon name used by the app' },
      imageUrl: { type: 'text', schema: z.string().nullable().optional(), hint: '/uploads/… or https://…' },
      subcategories: { type: 'list', schema: z.array(z.string()) },
      sortOrder: { type: 'number', schema: z.number().int() },
      active: { type: 'bool', schema: z.boolean() },
    },
    guardDelete: async (id) => { const n = await prisma.product.count({ where: { categoryId: id } }); if (n) throw new ApiError(400, `${n} product(s) still use this category. Move or delete them first.`); },
  },
  products: {
    model: 'product', label: 'Products', id: 'id', search: ['id', 'name', 'brand', 'subcategory'], order: { name: 'asc' },
    include: { tiers: { orderBy: { minQty: 'asc' } } },
    fields: {
      id: { type: 'text', schema: slug, create: true, key: true },
      categoryId: { type: 'ref', ref: 'categories', schema: z.string().min(1) },
      name: { type: 'text', schema: z.string().min(2) },
      brand: { type: 'text', schema: z.string().min(1) },
      subcategory: { type: 'text', schema: z.string().min(1) },
      unit: { type: 'enum', options: ['pc', 'pair', 'set', 'box'], schema: z.enum(['pc', 'pair', 'set', 'box']) },
      moq: { type: 'number', schema: z.number().int().positive() },
      description: { type: 'textarea', schema: z.string() },
      images: { type: 'list', schema: z.array(z.string()) },
      sizes: { type: 'list', schema: z.array(z.string()) },
      features: { type: 'json', schema: z.array(z.object({ label: z.string(), icon: z.string() })) },
      rating: { type: 'number', schema: z.number().min(0).max(5) },
      reviewCount: { type: 'number', schema: z.number().int().min(0) },
      inStock: { type: 'bool', schema: z.boolean() },
      popular: { type: 'bool', schema: z.boolean() },
      customisable: { type: 'bool', schema: z.boolean() },
      active: { type: 'bool', schema: z.boolean() },
      tiers: { type: 'tiers', schema: z.array(z.object({ minQty: z.number().int().positive(), unitPrice: money })).min(1), virtual: true },
    },
    serialize: (p) => ({ ...p, rating: Number(p.rating), tiers: (p.tiers || []).map((t) => ({ minQty: t.minQty, unitPrice: Number(t.unitPrice) / 100 })) }),
    beforeWrite: async (data, existing) => {
      if (data.tiers) {
        const tiers = data.tiers.map((t) => ({ minQty: t.minQty, unitPrice: BigInt(Math.round(t.unitPrice * 100)) }));
        const problem = validateTiers(tiers, data.moq ?? existing?.moq ?? 1);
        if (problem) throw new ApiError(400, problem);
        data.__tiers = tiers; delete data.tiers;
      }
    },
    afterWrite: async (tx, row, data) => {
      if (data.__tiers) { await tx.productTier.deleteMany({ where: { productId: row.id } }); await tx.productTier.createMany({ data: data.__tiers.map((t) => ({ ...t, productId: row.id })) }); }
    },
    guardDelete: async (id) => { const n = await prisma.orderItem.count({ where: { productId: id } }); if (n) throw new ApiError(400, `${n} order line(s) reference this product. Set active=false instead of deleting.`); },
  },
  users: {
    model: 'user', label: 'Users', id: 'id', search: ['mobile'], order: { createdAt: 'desc' }, include: { profile: true, _count: { select: { orders: true, addresses: true } } },
    fields: {
      id: { type: 'text', readonly: true, key: true },
      mobile: { type: 'text', schema: mobile, create: true },
      role: { type: 'enum', options: ['buyer', 'admin'], schema: z.enum(['buyer', 'admin']) },
      creditLimit: { type: 'money', schema: money },
      createdAt: { type: 'text', readonly: true },
      // profile (nested) — written through beforeWrite/afterWrite
      'profile.businessName': { type: 'text', schema: z.string().min(2).optional(), label: 'Business name' },
      'profile.contactName': { type: 'text', schema: z.string().min(2).optional(), label: 'Contact name' },
      'profile.gstin': { type: 'text', schema: gstin.optional(), label: 'GSTIN' },
      'profile.businessType': { type: 'enum', options: ['retailer', 'wholesaler', 'academy', 'school', 'club', 'gym', 'corporate', 'other'], schema: businessType.optional(), label: 'Business type' },
      'profile.email': { type: 'text', schema: email.optional(), label: 'Email' },
      'profile.mobile': { type: 'text', schema: mobile.optional(), label: 'Profile mobile' },
    },
    money: ['creditLimit'],
    serialize: (u) => ({ ...u, creditLimit: Number(u.creditLimit) / 100, ordersCount: u._count?.orders ?? 0, addressesCount: u._count?.addresses ?? 0, _count: undefined,
      'profile.businessName': u.profile?.businessName ?? '', 'profile.contactName': u.profile?.contactName ?? '', 'profile.gstin': u.profile?.gstin ?? '', 'profile.businessType': u.profile?.businessType ?? '', 'profile.email': u.profile?.email ?? '', 'profile.mobile': u.profile?.mobile ?? '' }),
    beforeWrite: async (data) => {
      const profile = {};
      for (const k of Object.keys(data)) if (k.startsWith('profile.')) { if (data[k] !== '' && data[k] != null) profile[k.slice(8)] = data[k]; delete data[k]; }
      if (Object.keys(profile).length) data.__profile = profile;
      if (data.creditLimit != null) data.creditLimit = BigInt(Math.round(data.creditLimit * 100));
    },
    afterWrite: async (tx, row, data) => {
      if (!data.__profile) return;
      const existing = await tx.businessProfile.findUnique({ where: { userId: row.id } });
      const required = ['businessName', 'contactName', 'gstin', 'businessType', 'email', 'mobile'];
      if (existing) { await tx.businessProfile.update({ where: { userId: row.id }, data: data.__profile }); return; }
      const missing = required.filter((k) => !data.__profile[k] && k !== 'mobile');
      if (missing.length) throw new ApiError(400, `To create a profile fill: ${missing.join(', ')}`);
      await tx.businessProfile.create({ data: { userId: row.id, mobile: row.mobile, ...data.__profile } });
    },
    guardDelete: async (id) => { const n = await prisma.order.count({ where: { userId: id } }); if (n) throw new ApiError(400, `User has ${n} order(s). Orders must be deleted first (cancelled ones can be).`); },
  },
  addresses: {
    model: 'address', label: 'Addresses', id: 'id', search: ['contactName', 'businessName', 'city', 'pincode', 'mobile'], order: { createdAt: 'desc' },
    fields: {
      id: { type: 'text', readonly: true, key: true },
      userId: { type: 'ref', ref: 'users', schema: z.string().uuid(), create: true },
      contactName: { type: 'text', schema: z.string().min(2) }, businessName: { type: 'text', schema: z.string() },
      line1: { type: 'text', schema: z.string().min(4) }, line2: { type: 'text', schema: z.string() },
      city: { type: 'text', schema: z.string().min(1) }, state: { type: 'text', schema: z.string().min(1) }, pincode: { type: 'text', schema: pincode },
      mobile: { type: 'text', schema: mobile },
      label: { type: 'enum', options: ['home', 'office', 'warehouse', 'ground', 'other'], schema: z.enum(['home', 'office', 'warehouse', 'ground', 'other']) },
      isDefault: { type: 'bool', schema: z.boolean() },
    },
    afterWrite: async (tx, row, data) => { if (data.isDefault) await tx.address.updateMany({ where: { userId: row.userId, NOT: { id: row.id } }, data: { isDefault: false } }); },
  },
  orders: {
    model: 'order', label: 'Orders', id: 'id', search: ['id', 'invoiceId', 'trackingId'], order: { placedAt: 'desc' },
    include: { items: true, user: { select: { mobile: true, profile: { select: { businessName: true } } } }, payments: true, history: { orderBy: { at: 'asc' } } },
    fields: {
      id: { type: 'text', readonly: true, key: true },
      userId: { type: 'ref', ref: 'users', readonly: true },
      status: { type: 'enum', options: ['paymentPending', 'placed', 'packed', 'dispatched', 'outForDelivery', 'delivered', 'cancelled'], schema: z.enum(['paymentPending', 'placed', 'packed', 'dispatched', 'outForDelivery', 'delivered', 'cancelled']) },
      paymentMethod: { type: 'enum', options: ['razorpay', 'payLater'], schema: z.enum(['razorpay', 'payLater']) },
      paid: { type: 'bool', schema: z.boolean() },
      subtotal: { type: 'money', schema: money }, gst: { type: 'money', schema: money }, total: { type: 'money', schema: money },
      invoiceId: { type: 'text', schema: z.string().min(2) },
      trackingId: { type: 'text', schema: z.string().nullable() },
      etaStart: { type: 'date', schema: dateish }, etaEnd: { type: 'date', schema: dateish },
      address: { type: 'json', schema: z.record(z.string(), z.any()) },
      placedAt: { type: 'text', readonly: true },
    },
    money: ['subtotal', 'gst', 'total'],
    serialize: (o) => ({ ...o, subtotal: Number(o.subtotal) / 100, gst: Number(o.gst) / 100, total: Number(o.total) / 100,
      buyer: o.user ? `${o.user.profile?.businessName || ''} ${o.user.mobile}`.trim() : '', user: undefined,
      items: (o.items || []).map((i) => ({ ...i, id: String(i.id), unitPrice: Number(i.unitPrice) / 100 })),
      payments: (o.payments || []).map((p) => ({ ...p, amount: Number(p.amount) / 100, raw: undefined })),
      history: (o.history || []).map((h) => ({ ...h, id: String(h.id) })) }),
    beforeWrite: async (data, existing) => {
      for (const k of ['subtotal', 'gst', 'total']) if (data[k] != null) data[k] = BigInt(Math.round(data[k] * 100));
      for (const k of ['etaStart', 'etaEnd']) if (data[k]) data[k] = new Date(data[k]);
      if (data.status && existing && data.status !== existing.status) data.__history = { status: data.status, note: 'Changed from the admin database console' };
      if (data.status) data.statusUpdatedAt = new Date();
    },
    afterWrite: async (tx, row, data) => { if (data.__history) await tx.orderStatusHistory.create({ data: { orderId: row.id, ...data.__history } }); },
    guardDelete: async (id) => {
      const o = await prisma.order.findUnique({ where: { id }, include: { payments: true } });
      if (!o) return;
      if (!['cancelled', 'paymentPending'].includes(o.status)) throw new ApiError(400, 'Only cancelled or payment-pending orders can be deleted. Cancel it first.');
      if (o.payments.some((p) => p.status === 'captured' && !p.refundId)) throw new ApiError(400, 'This order has a captured payment. Refund it before deleting.');
      await prisma.payment.deleteMany({ where: { orderId: id } });
    },
  },
  payments: {
    model: 'payment', label: 'Payments', id: 'id', search: ['orderId', 'razorpayOrderId', 'razorpayPaymentId'], order: { createdAt: 'desc' },
    fields: {
      id: { type: 'text', readonly: true, key: true }, orderId: { type: 'ref', ref: 'orders', readonly: true },
      razorpayOrderId: { type: 'text', readonly: true }, razorpayPaymentId: { type: 'text', readonly: true },
      amount: { type: 'money', readonly: true }, method: { type: 'text', readonly: true },
      status: { type: 'enum', options: ['created', 'captured', 'failed', 'refunded'], schema: z.enum(['created', 'captured', 'failed', 'refunded']) },
      refundId: { type: 'text', schema: z.string().nullable() }, capturedAt: { type: 'text', readonly: true }, createdAt: { type: 'text', readonly: true },
    },
    serialize: (p) => ({ ...p, amount: Number(p.amount) / 100, raw: undefined }),
    noCreate: true,
  },
  quotes: {
    model: 'quote', label: 'Quote requests', id: 'id', search: ['id', 'contactName', 'contactMobile'], order: { createdAt: 'desc' }, include: { items: true },
    fields: {
      id: { type: 'text', readonly: true, key: true }, userId: { type: 'ref', ref: 'users', readonly: true },
      kind: { type: 'enum', options: ['bulk', 'custom', 'csv'], schema: z.enum(['bulk', 'custom', 'csv']) },
      status: { type: 'enum', options: ['submitted', 'underReview', 'quoted', 'accepted', 'declined'], schema: z.enum(['submitted', 'underReview', 'quoted', 'accepted', 'declined']) },
      quotedTotal: { type: 'money', schema: money.nullable() }, adminNote: { type: 'textarea', schema: z.string().nullable() }, notes: { type: 'textarea', readonly: true },
      contactName: { type: 'text', schema: z.string().nullable() }, contactMobile: { type: 'text', schema: mobile.nullable() }, source: { type: 'text', readonly: true }, createdAt: { type: 'text', readonly: true },
    },
    serialize: (q) => ({ ...q, quotedTotal: q.quotedTotal == null ? null : Number(q.quotedTotal) / 100, items: (q.items || []).map((i) => ({ ...i, id: String(i.id) })) }),
    beforeWrite: async (data) => { if (data.quotedTotal != null) data.quotedTotal = BigInt(Math.round(data.quotedTotal * 100)); },
    noCreate: true,
  },
  leads: {
    model: 'lead', label: 'Leads / enquiries', id: 'id', search: ['name', 'business', 'mobile', 'email'], order: { createdAt: 'desc' },
    fields: {
      id: { type: 'text', readonly: true, key: true },
      name: { type: 'text', schema: z.string().min(2) }, business: { type: 'text', schema: z.string().nullable() },
      mobile: { type: 'text', schema: mobile }, email: { type: 'text', schema: email.nullable().or(z.literal('')) },
      message: { type: 'textarea', schema: z.string().min(1) }, sourcePage: { type: 'text', schema: z.string().nullable() }, createdAt: { type: 'text', readonly: true },
    },
  },
  notifications: {
    model: 'notification', label: 'Notifications', id: 'id', search: ['title', 'body'], order: { createdAt: 'desc' },
    fields: {
      id: { type: 'text', readonly: true, key: true }, userId: { type: 'ref', ref: 'users', schema: z.string().uuid(), create: true },
      type: { type: 'enum', options: ['orderPlaced', 'orderShipped', 'orderDelivered', 'offer', 'newProduct', 'priceDrop', 'quote'], schema: z.enum(['orderPlaced', 'orderShipped', 'orderDelivered', 'offer', 'newProduct', 'priceDrop', 'quote']) },
      title: { type: 'text', schema: z.string().min(1) }, body: { type: 'textarea', schema: z.string().min(1) },
      read: { type: 'bool', schema: z.boolean() }, orderId: { type: 'text', schema: z.string().nullable() }, productId: { type: 'text', schema: z.string().nullable() }, createdAt: { type: 'text', readonly: true },
    },
  },
  team: {
    model: 'teamMember', label: 'Team members', id: 'id', search: ['name', 'mobile'], order: { createdAt: 'desc' },
    fields: {
      id: { type: 'text', readonly: true, key: true }, userId: { type: 'ref', ref: 'users', schema: z.string().uuid(), create: true },
      name: { type: 'text', schema: z.string().min(1) }, mobile: { type: 'text', schema: mobile },
      role: { type: 'enum', options: ['purchaser', 'accounts', 'viewer'], schema: z.enum(['purchaser', 'accounts', 'viewer']) }, createdAt: { type: 'text', readonly: true },
    },
  },
  devices: { model: 'deviceToken', label: 'Device tokens', id: 'token', search: ['token', 'platform'], order: { updatedAt: 'desc' },
    fields: { token: { type: 'text', readonly: true, key: true }, userId: { type: 'ref', ref: 'users', readonly: true }, platform: { type: 'text', readonly: true }, updatedAt: { type: 'text', readonly: true } }, noCreate: true, noUpdate: true },
  otp: { model: 'otpCode', label: 'OTP codes', id: 'mobile', search: ['mobile'], order: { expiresAt: 'desc' },
    fields: { mobile: { type: 'text', readonly: true, key: true }, expiresAt: { type: 'text', readonly: true }, attempts: { type: 'number', readonly: true } }, noCreate: true, noUpdate: true,
    serialize: (o) => ({ ...o, codeHash: undefined }) },
};

const table = (name) => { const t = TABLES[name]; if (!t) throw new ApiError(404, `Unknown table "${name}".`); return t; };
const json = (v) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
const serialize = (t, row) => json(t.serialize ? t.serialize(row) : row);

function schemaFor(t, mode) {
  const shape = {};
  for (const [k, f] of Object.entries(t.fields)) {
    if (f.readonly || !f.schema) continue;
    if (mode === 'create' && f.key && !f.create) continue;
    shape[k] = mode === 'update' ? f.schema.optional() : (f.create || f.key ? f.schema : f.schema.optional());
  }
  return z.object(shape).strict();
}

const r = Router();

r.get('/', (_req, res) => ok(res, Object.entries(TABLES).map(([name, t]) => ({
  name, label: t.label, id: t.id, noCreate: !!t.noCreate, noUpdate: !!t.noUpdate,
  fields: Object.entries(t.fields).map(([k, f]) => ({ name: k, label: f.label || k, type: f.type, options: f.options, ref: f.ref, readonly: !!f.readonly, key: !!f.key, create: !!f.create, hint: f.hint })),
}))));

/** Quick counts for the console header. */
r.get('/_meta/stats', asyncHandler(async (_req, res) => {
  const entries = await Promise.all(Object.entries(TABLES).map(async ([name, t]) => [name, await prisma[t.model].count()]));
  ok(res, Object.fromEntries(entries));
}));

r.get('/:table', asyncHandler(async (req, res) => {
  const t = table(req.params.table);
  const q = String(req.query.q || '').trim();
  const take = Math.min(Number(req.query.limit) || 50, 200), skip = Math.max(Number(req.query.offset) || 0, 0);
  const where = q ? { OR: t.search.map((f) => ({ [f]: { contains: q, mode: 'insensitive' } })) } : {};
  const [rows, total] = await Promise.all([
    prisma[t.model].findMany({ where, include: t.include, orderBy: t.order, take, skip }),
    prisma[t.model].count({ where }),
  ]);
  ok(res, { rows: rows.map((x) => serialize(t, x)), total, limit: take, offset: skip });
}));

r.get('/:table/:id', asyncHandler(async (req, res) => {
  const t = table(req.params.table);
  const row = await prisma[t.model].findUnique({ where: { [t.id]: req.params.id }, include: t.include });
  if (!row) throw new ApiError(404, 'Row not found.');
  ok(res, serialize(t, row));
}));

r.post('/:table', asyncHandler(async (req, res) => {
  const t = table(req.params.table);
  if (t.noCreate) throw new ApiError(400, `Rows in "${t.label}" are created by the system, not by hand.`);
  const data = schemaFor(t, 'create').parse(req.body);
  if (t.beforeWrite) await t.beforeWrite(data, null);
  const extra = {}; for (const k of Object.keys(data)) if (k.startsWith('__')) { extra[k] = data[k]; delete data[k]; }
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx[t.model].create({ data });
    if (t.afterWrite) await t.afterWrite(tx, created, extra);
    return tx[t.model].findUnique({ where: { [t.id]: created[t.id] }, include: t.include });
  });
  ok(res, serialize(t, row), 201);
}));

r.put('/:table/:id', asyncHandler(async (req, res) => {
  const t = table(req.params.table);
  if (t.noUpdate) throw new ApiError(400, `Rows in "${t.label}" cannot be edited.`);
  const existing = await prisma[t.model].findUnique({ where: { [t.id]: req.params.id } });
  if (!existing) throw new ApiError(404, 'Row not found.');
  const data = schemaFor(t, 'update').parse(req.body);
  if (t.beforeWrite) await t.beforeWrite(data, existing);
  const extra = {}; for (const k of Object.keys(data)) if (k.startsWith('__')) { extra[k] = data[k]; delete data[k]; }
  const row = await prisma.$transaction(async (tx) => {
    const updated = Object.keys(data).length ? await tx[t.model].update({ where: { [t.id]: req.params.id }, data }) : existing;
    if (t.afterWrite) await t.afterWrite(tx, updated, extra);
    return tx[t.model].findUnique({ where: { [t.id]: req.params.id }, include: t.include });
  });
  ok(res, serialize(t, row));
}));

r.delete('/:table/:id', asyncHandler(async (req, res) => {
  const t = table(req.params.table);
  const existing = await prisma[t.model].findUnique({ where: { [t.id]: req.params.id } });
  if (!existing) throw new ApiError(404, 'Row not found.');
  if (t.guardDelete) await t.guardDelete(req.params.id);
  await prisma[t.model].delete({ where: { [t.id]: req.params.id } });
  ok(res, { deleted: req.params.id });
}));

export default r;
