import { Link } from "react-router-dom";
import messlyLogo from "../assets/icons/ui/messly.svg";

export function PublicLandingPage() {
  return (
    <article className="public-page public-page--landing-v2">
      <header className="landing-v2-topbar" aria-label="Cabecalho da landing page">
        <Link className="landing-v2-brand" to="/">
          <img className="landing-v2-brand__logo" src={messlyLogo} alt="" aria-hidden="true" />
          <span className="landing-v2-brand__name">Azyoons</span>
        </Link>

        <Link className="landing-v2-login" to="/auth/login">
          Entrar
        </Link>
      </header>

      <section className="landing-v2-hero">
        <h1 className="landing-v2-hero__title">Converse com qualquer pessoa</h1>
        <p className="landing-v2-hero__text">
          Azyoons e uma plataforma moderna de mensagens para conversar com amigos, equipes e
          comunidades em tempo real.
        </p>

        <div className="landing-v2-hero__actions">
          <button className="landing-v2-button landing-v2-button--secondary" type="button" disabled>
            Baixar para Windows (em breve)
          </button>
          <Link className="landing-v2-button landing-v2-button--primary" to="/app">
            Abrir no navegador
          </Link>
        </div>
      </section>
    </article>
  );
}
