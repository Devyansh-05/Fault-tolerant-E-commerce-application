/** Summary card. `value` always comes from the backend; null renders as "—". */
export default function MetricCard({ label, value, hint, tone = 'default' }) {
  return (
    <div className={`metric card metric-${tone}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value ?? '—'}</span>
      {hint && <span className="metric-hint">{hint}</span>}
    </div>
  );
}
