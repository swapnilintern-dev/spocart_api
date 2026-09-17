/** Validates req.body (or req.query) with a zod schema; replaces it with the parsed value. */
export const validate = (schema, source = 'body') => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) return next(result.error);
  if (source === 'body') req.body = result.data;
  else req.validated = result.data;
  next();
};
