export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div>
          <strong>ShopSphere</strong>
          <p className="muted">A fault-tolerant e-commerce platform. Payments are simulated; no real money is charged.</p>
        </div>
        <p className="muted small">© {new Date().getFullYear()} ShopSphere — Academic project</p>
      </div>
    </footer>
  );
}
