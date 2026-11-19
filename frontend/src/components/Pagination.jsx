export default function Pagination({ page, totalPages, onChange }) {
  if (!totalPages || totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1).filter(
    (p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1
  );

  return (
    <nav className="pagination" aria-label="Pagination">
      <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
        ‹ Prev
      </button>
      {pages.map((p, index) => (
        <span key={p} className="pagination-item">
          {index > 0 && p - pages[index - 1] > 1 && <span className="muted">…</span>}
          <button
            type="button"
            className={`btn btn-sm ${p === page ? 'btn-primary' : 'btn-ghost'}`}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        </span>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Next ›
      </button>
    </nav>
  );
}
