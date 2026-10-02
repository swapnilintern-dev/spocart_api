/** Throw this for any failure the buyer should see as a message. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(_req, res) {
  res.status(404).json({ ok: false, message: 'Route not found.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) return res.status(err.status).json({ ok: false, message: err.message });
  if (err?.name === 'ZodError') {
    const issue = err.issues?.[0];
    const field = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return res.status(400).json({ ok: false, message: `${field}${issue?.message ?? 'Invalid input'}` });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, message: 'Invalid JSON body.' });

  // Prisma's constraint failures are the admin's typing, not a server fault:
  // say which field, instead of "something went wrong".
  if (err?.code === 'P2002') {
    const fields = (err.meta?.target ?? []).join(', ');
    return res.status(409).json({
      ok: false,
      message: fields
        ? `Another record already uses that ${fields}. It has to be unique.`
        : 'Another record already uses one of those values. It has to be unique.',
    });
  }
  if (err?.code === 'P2003') {
    return res.status(400).json({ ok: false, message: 'That references a record that does not exist.' });
  }
  if (err?.code === 'P2025') {
    return res.status(404).json({ ok: false, message: 'That record no longer exists.' });
  }
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ ok: false, message: 'File is too large (max 25 MB).' });
  (req.log ?? console).error(err);
  res.status(500).json({ ok: false, message: 'Something went wrong. Please try again.' });
}
