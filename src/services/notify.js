// The server is the only writer of the notification inbox.
export function notify(tx, userId, { type, title, body, orderId, productId, quoteId }) {
  return tx.notification.create({ data: { userId, type, title, body, orderId, productId, quoteId } });
}
