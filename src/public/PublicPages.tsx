import { Link } from "react-router-dom";
import messlyLogo from "../assets/icons/ui/messly.svg";

const POLICY_UPDATED_AT = "14 de marco de 2026";

export function PublicLandingPage() {
  return (
    <article className="public-page public-page--landing-v2">
      <header className="landing-v2-topbar" aria-label="Cabecalho da landing page">
        <Link className="landing-v2-brand" to="/">
          <img className="landing-v2-brand__logo" src={messlyLogo} alt="" aria-hidden="true" />
          <span className="landing-v2-brand__name">Messly</span>
        </Link>

        <Link className="landing-v2-login" to="/auth/login">
          Entrar
        </Link>
      </header>

      <section className="landing-v2-hero">
        <h1 className="landing-v2-hero__title">Converse com qualquer pessoa</h1>
        <p className="landing-v2-hero__text">
          Messly e uma plataforma moderna de mensagens para conversar com amigos, equipes e
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

export function PublicTermsPage() {
  return (
    <article className="public-page">
      <section className="public-policy-shell">
        <header className="public-policy-header">
          <h1>Termos de Uso</h1>
          <p>Ultima revisao: {POLICY_UPDATED_AT}</p>
        </header>

        <article className="public-policy-block">
          <h2>1. Aceitacao</h2>
          <p>
            Ao criar conta, acessar ou utilizar o Messly, voce declara que leu, compreendeu e concorda com estes
            Termos de Uso e com a Politica de Privacidade.
          </p>
        </article>

        <article className="public-policy-block">
          <h2>2. Uso da plataforma</h2>
          <p>
            O Messly oferece comunicacao em tempo real com mensagens, comunidades e compartilhamento de
            arquivos. O uso deve respeitar a legislacao brasileira e as regras da plataforma.
          </p>
        </article>

        <article className="public-policy-block">
          <h2>3. Responsabilidade do usuario</h2>
          <ul>
            <li>Manter a seguranca da conta e da senha.</li>
            <li>Fornecer dados verdadeiros no cadastro.</li>
            <li>Nao praticar abuso, fraude, phishing, spam ou condutas ilegais.</li>
            <li>Respeitar direitos de terceiros e propriedade intelectual.</li>
          </ul>
        </article>

        <article className="public-policy-block">
          <h2>4. Suspensao e encerramento</h2>
          <p>
            Contas podem ser limitadas, suspensas ou encerradas em caso de violacao destes termos, das regras da
            comunidade ou de obrigacoes legais.
          </p>
        </article>

        <article className="public-policy-block">
          <h2>5. Legislacao aplicavel</h2>
          <p>
            Estes termos sao regidos pelas leis da Republica Federativa do Brasil, incluindo o Marco Civil da Internet
            (Lei no 12.965/2014) e a legislacao civil aplicavel.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicPrivacyPage() {
  return (
    <article className="public-page">
      <section className="public-policy-shell">
        <header className="public-policy-header">
          <h1>Politica de Privacidade</h1>
          <p>Ultima revisao: {POLICY_UPDATED_AT}</p>
        </header>

        <article className="public-policy-block">
          <h2>1. Dados coletados</h2>
          <p>O Messly pode coletar os seguintes dados para operacao da plataforma:</p>
          <ul>
            <li>E-mail.</li>
            <li>Nome de usuario.</li>
            <li>Endereco IP.</li>
            <li>Dados do dispositivo.</li>
            <li>Mensagens enviadas.</li>
            <li>Arquivos enviados, incluindo imagens e GIFs.</li>
          </ul>
        </article>

        <article className="public-policy-block">
          <h2>2. Como os dados sao usados</h2>
          <ul>
            <li>Autenticacao e seguranca da conta.</li>
            <li>Funcionamento de chat e envio de arquivos.</li>
            <li>Prevencao de fraude, spam e abuso.</li>
            <li>Melhoria de estabilidade e desempenho da plataforma.</li>
          </ul>
        </article>

        <article className="public-policy-block">
          <h2>3. Compartilhamento e armazenamento</h2>
          <p>
            Os dados sao armazenados com controles tecnicos e administrativos de seguranca e somente sao compartilhados
            quando necessario para operacao do servico, cumprimento legal ou defesa de direitos.
          </p>
        </article>

        <article className="public-policy-block">
          <h2>4. Direitos do titular (LGPD)</h2>
          <p>Nos termos da Lei no 13.709/2018 (LGPD), voce pode solicitar:</p>
          <ul>
            <li>Confirmacao de tratamento e acesso aos dados.</li>
            <li>Correcao, bloqueio ou eliminacao quando cabivel.</li>
            <li>Informacoes sobre compartilhamento e portabilidade.</li>
            <li>Revogacao de consentimento, quando aplicavel.</li>
          </ul>
          <p>
            Canal de atendimento LGPD: <a href="mailto:privacidade@messly.site">privacidade@messly.site</a>.
          </p>
        </article>
      </section>
    </article>
  );
}
