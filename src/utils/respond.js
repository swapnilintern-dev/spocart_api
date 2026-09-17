/** Success envelope: { ok: true, data }. Errors go through middleware/error.js. */
export const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });
