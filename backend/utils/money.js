/**
 * Money helpers. Prices are stored as decimal rupees (max 2 decimals) but all
 * arithmetic is done in integer paise to avoid floating-point rounding errors.
 */
export const CURRENCY = 'INR';

export const toMinorUnits = (amount) => Math.round(Number(amount) * 100);
export const fromMinorUnits = (minor) => Math.round(minor) / 100;

/** Multiplies a unit price by a quantity without floating-point drift. */
export const multiplyPrice = (unitPrice, quantity) => fromMinorUnits(toMinorUnits(unitPrice) * quantity);

/** Sums a list of decimal amounts exactly. */
export const sumAmounts = (amounts) => fromMinorUnits(amounts.reduce((total, a) => total + toMinorUnits(a), 0));

const inrFormatter = new Intl.NumberFormat('en-IN', { style: 'currency', currency: CURRENCY });
export const formatInr = (amount) => inrFormatter.format(Number(amount) || 0);

export const hasAtMostTwoDecimals = (value) => Number.isFinite(value) && Math.abs(toMinorUnits(value) - value * 100) < 1e-6;
