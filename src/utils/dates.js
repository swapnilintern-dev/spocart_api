export const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);
export const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
