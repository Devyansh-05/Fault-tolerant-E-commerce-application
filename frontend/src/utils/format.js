const currency = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

export const formatPrice = (amount) => currency.format(Number(amount) || 0);
export const formatDateTime = (value) => (value ? dateTime.format(new Date(value)) : '—');
