import { Link, NavLink, Outlet } from "react-router-dom";
import "./publicSite.css";

interface HeaderLink {
  to: string;
  label: string;
}

const headerLinks: HeaderLink[] = [
  { to: "/recursos", label: "Recursos" },
  { to: "/download", label: "Download" },
  { to: "/seguranca", label: "Seguranca" },
  { to: "/status", label: "Status" },
  { to: "/suporte", label: "Suporte" },
];

const footerLinks: HeaderLink[] = [
  { to: "/download", label: "Download" },
  { to: "/recursos", label: "Recursos" },
  { to: "/seguranca", label: "Seguranca" },
  { to: "/suporte", label: "Suporte" },
  { to: "/diretrizes-da-comunidade", label: "Diretrizes da Comunidade" },
  { to: "/termos-de-uso", label: "Termos de Uso" },
  { to: "/politica-de-privacidade", label: "Politica de Privacidade" },
  { to: "/politica-de-cookies", label: "Cookies" },
  { to: "/status", label: "Status do servico" },
  { to: "/contato", label: "Contato" },
  { to: "/propriedade-intelectual", label: "Propriedade Intelectual" },
];

function navClassName(isActive: boolean): string {
  return isActive ? "public-site__nav-link public-site__nav-link--active" : "public-site__nav-link";
}

export default function PublicSiteLayout() {
  return (
    <div className="public-site" data-messly-startup-surface="auth">
      <header className="public-site__header">
        <div className="public-site__container public-site__header-content">
          <Link className="public-site__brand" to="/">
            <span className="public-site__brand-mark" aria-hidden="true">
              M
            </span>
            <span className="public-site__brand-name">Messly</span>
          </Link>

          <nav className="public-site__header-nav" aria-label="Navegacao principal do site">
            {headerLinks.map((item) => (
              <NavLink key={item.to} className={({ isActive }) => navClassName(isActive)} to={item.to}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="public-site__header-actions">
            <Link className="public-button public-button--ghost" to="/download">
              Baixar aplicativo
            </Link>
            <Link className="public-button public-button--solid" to="/app">
              Abrir no navegador
            </Link>
          </div>
        </div>
      </header>

      <main className="public-site__main">
        <div className="public-site__container">
          <Outlet />
        </div>
      </main>

      <footer className="public-site__footer">
        <div className="public-site__container public-site__footer-content">
          <div className="public-site__footer-top">
            <div className="public-site__footer-brand">
              <p className="public-site__footer-title">Messly</p>
              <p className="public-site__footer-subtitle">
                Plataforma de comunicacao em tempo real para comunidades, equipes e amigos.
              </p>
            </div>
            <nav className="public-site__footer-links" aria-label="Links institucionais do rodape">
              {footerLinks.map((item) => (
                <NavLink key={item.to} className={({ isActive }) => navClassName(isActive)} to={item.to}>
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="public-site__footer-bottom">
            <p>&copy; 2026 Messly &mdash; Todos os direitos reservados.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
