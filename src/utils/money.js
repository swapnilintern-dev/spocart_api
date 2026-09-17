// All amounts are BigInt paise in the database. Convert only at the JSON edge.
export const toRupees = (paise) => Number(paise) / 100;
export const inr = (paise) => '₹' + toRupees(paise).toLocaleString('en-IN', { maximumFractionDigits: 0 });
