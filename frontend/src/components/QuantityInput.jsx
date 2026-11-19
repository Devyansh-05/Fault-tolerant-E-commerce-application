export default function QuantityInput({ value, min = 1, max = 20, onChange, disabled = false }) {
  const clamp = (n) => Math.max(min, Math.min(max, n));
  return (
    <div className="qty">
      <button type="button" aria-label="Decrease quantity" disabled={disabled || value <= min} onClick={() => onChange(clamp(value - 1))}>
        −
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="Increase quantity" disabled={disabled || value >= max} onClick={() => onChange(clamp(value + 1))}>
        +
      </button>
    </div>
  );
}
