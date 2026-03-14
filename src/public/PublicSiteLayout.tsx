import { Link, Outlet } from "react-router-dom";
import "./publicSite.css";

export default function PublicSiteLayout() {
  return (
    <div className="public-site" data-messly-startup-surface="auth">
      <main className="public-site__main">
        <div className="public-site__container">
          <Outlet />
        </div>
      </main>

      <footer className="public-site__footer">
        <div className="public-site__container public-site__footer-content">
          <nav className="public-site__footer-links" aria-label="Links legais">
            <Link to="/terms">Termos</Link>
            <Link to="/privacy">Privacidade</Link>
          </nav>
          <div className="public-site__footer-bottom">
            <p>&copy; 2026 Messly &mdash; Todos os direitos reservados.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
