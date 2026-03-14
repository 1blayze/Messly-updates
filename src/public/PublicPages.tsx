import { Link } from "react-router-dom";

type ServiceStatusLevel = "operational" | "degraded" | "maintenance";

interface FeatureItem {
  title: string;
  description: string;
}

interface ServiceStatusItem {
  name: string;
  level: ServiceStatusLevel;
  detail: string;
}

const POLICY_UPDATED_AT = "14 de marco de 2026";
const APP_VERSION = "0.0.24";

const landingFeatureHighlights: FeatureItem[] = [
  {
    title: "Chat em tempo real",
    description: "Converse instantaneamente em servidores, canais e mensagens privadas com entrega rapida e estavel.",
  },
  {
    title: "Chamadas de voz e video",
    description: "Entre em chamadas com baixa latencia para estudos, comunidades, jogos e reunioes.",
  },
  {
    title: "Perfis personalizados",
    description: "Use avatar, banner, status e tema de perfil para representar sua identidade na plataforma.",
  },
  {
    title: "Arquivos e midia",
    description: "Envie documentos, imagens e GIFs em conversas individuais e canais de comunidade.",
  },
];

const fullFeatureList: FeatureItem[] = [
  {
    title: "Chat em tempo real",
    description: "Mensagens sincronizadas com atualizacao imediata para manter as conversas fluindo em qualquer dispositivo.",
  },
  {
    title: "Mensagens privadas (DM)",
    description: "Converse em privado com controle de notificacoes, anexos, historico e chamadas diretas.",
  },
  {
    title: "Sistema de amigos",
    description: "Adicione, aceite e gerencie amizades com fluxo rapido para iniciar conversa e chamada.",
  },
  {
    title: "Servidores e comunidades",
    description: "Estruture comunidades com canais, papeis e espacos dedicados para temas, eventos e equipes.",
  },
  {
    title: "Canais de texto",
    description: "Organize assuntos por canal para manter contexto, historico e colaboracao em cada topico.",
  },
  {
    title: "Chamadas de voz",
    description: "Conversas de audio para grupos e contatos diretos com foco em estabilidade e qualidade.",
  },
  {
    title: "Chamadas de video",
    description: "Comunicacao face a face para reunioes, aulas e encontros online com alternancia rapida.",
  },
  {
    title: "Envio de arquivos",
    description: "Compartilhamento de arquivos, imagens e GIFs com previsao de upload e visualizacao.",
  },
  {
    title: "Perfis personalizados",
    description: "Avatar, banner, nome exibido e status para personalizar como cada usuario aparece.",
  },
];

const securityItems: FeatureItem[] = [
  {
    title: "Conexoes seguras",
    description: "Todo o trafego e protegido por conexao segura, reduzindo risco de interceptacao de dados.",
  },
  {
    title: "Protecao contra spam",
    description: "Mecanismos de controle de abuso, limites operacionais e verificacoes para reduzir comportamentos abusivos.",
  },
  {
    title: "Protecao contra bots maliciosos",
    description: "Processos de verificacao e monitoramento para mitigar automacoes mal-intencionadas.",
  },
  {
    title: "Moderacao e denuncias",
    description: "Ferramentas de moderacao da plataforma, revisao de violacoes e fluxo de denuncias pelos usuarios.",
  },
];

const statusItems: ServiceStatusItem[] = [
  { name: "API", level: "operational", detail: "Operacional" },
  { name: "Gateway", level: "operational", detail: "Operacional" },
  { name: "Chat", level: "operational", detail: "Operacional" },
  { name: "Chamadas de voz", level: "operational", detail: "Operacional" },
  { name: "Chamadas de video", level: "operational", detail: "Operacional" },
  { name: "Servidores", level: "operational", detail: "Operacional" },
];

function PublicSectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="public-section__header">
      <p className="public-section__eyebrow">{eyebrow}</p>
      <h1 className="public-section__title">{title}</h1>
      {description ? <p className="public-section__description">{description}</p> : null}
    </header>
  );
}

function FeatureGrid({ items }: { items: FeatureItem[] }) {
  return (
    <div className="public-grid public-grid--cards">
      {items.map((item) => (
        <article key={item.title} className="public-card">
          <h2 className="public-card__title">{item.title}</h2>
          <p className="public-card__description">{item.description}</p>
        </article>
      ))}
    </div>
  );
}

export function PublicLandingPage() {
  return (
    <article className="public-page">
      <section className="public-hero">
        <p className="public-hero__eyebrow">Comunicacao em tempo real para comunidades e equipes</p>
        <h1 className="public-hero__title">Messly e uma plataforma de conversa, voz e video semelhante ao Discord.</h1>
        <p className="public-hero__description">
          O Messly conecta pessoas em tempo real com mensagens, comunidades, canais e chamadas para criar experiencias
          sociais, educacionais e profissionais em um unico lugar.
        </p>
        <div className="public-hero__actions">
          <Link className="public-button public-button--solid" to="/app">
            Abrir o Messly no navegador
          </Link>
          <Link className="public-button public-button--ghost" to="/download">
            Baixar o aplicativo
          </Link>
        </div>
      </section>

      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Principais recursos"
          title="Tudo para conversar, colaborar e construir comunidades."
          description="Recursos essenciais para chat, ligacoes, compartilhamento de arquivos e personalizacao de perfil."
        />
        <FeatureGrid items={landingFeatureHighlights} />
      </section>

      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Seguranca da plataforma"
          title="Protecao por camadas para manter o ambiente confiavel."
          description="Seguranca tecnica, monitoramento de abuso e ferramentas de moderacao para usuarios e comunidades."
        />
        <FeatureGrid items={securityItems} />
      </section>

      <section className="public-cta">
        <h2 className="public-cta__title">Comece agora no Messly</h2>
        <p className="public-cta__description">
          Crie sua conta, personalize seu perfil e participe de comunidades em tempo real.
        </p>
        <div className="public-hero__actions">
          <Link className="public-button public-button--solid" to="/app">
            Criar conta e entrar
          </Link>
          <Link className="public-button public-button--ghost" to="/recursos">
            Ver todos os recursos
          </Link>
        </div>
      </section>
    </article>
  );
}

export function PublicFeaturesPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Recursos"
          title="Funcionalidades do Messly"
          description="Conheca as funcionalidades principais disponiveis para uso no site e no aplicativo."
        />
        <FeatureGrid items={fullFeatureList} />
      </section>
    </article>
  );
}

export function PublicDownloadPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Download"
          title="Baixe o Messly para seu dispositivo"
          description="Use a versao web no navegador ou instale o aplicativo para uma experiencia dedicada."
        />

        <div className="public-grid public-grid--cards">
          <article className="public-card" id="download-windows">
            <h2 className="public-card__title">Windows</h2>
            <p className="public-card__description">Compatibilidade recomendada com Windows 10 ou superior (64-bit).</p>
            <button className="public-button public-button--muted" type="button" disabled>
              Download para Windows (em breve)
            </button>
          </article>

          <article className="public-card" id="download-macos">
            <h2 className="public-card__title">Mac</h2>
            <p className="public-card__description">Suporte para macOS recente com atualizacoes automaticas do app.</p>
            <button className="public-button public-button--muted" type="button" disabled>
              Download para Mac (em breve)
            </button>
          </article>

          <article className="public-card" id="download-linux">
            <h2 className="public-card__title">Linux</h2>
            <p className="public-card__description">
              Distribuicoes compativeis com AppImage e ambiente grafico moderno.
            </p>
            <button className="public-button public-button--muted" type="button" disabled>
              Download para Linux (em breve)
            </button>
          </article>

          <article className="public-card">
            <h2 className="public-card__title">Versao Web</h2>
            <p className="public-card__description">Acesse diretamente no navegador sem instalacao local.</p>
            <Link className="public-button public-button--solid" to="/app">
              Abrir versao Web
            </Link>
          </article>
        </div>
      </section>

      <section className="public-section public-section--split">
        <article className="public-card">
          <h2 className="public-card__title">Versao atual</h2>
          <p className="public-card__description">
            Versao da plataforma: <strong>{APP_VERSION}</strong>
          </p>
          <p className="public-card__meta">Atualizada em {POLICY_UPDATED_AT}</p>
        </article>

        <article className="public-card">
          <h2 className="public-card__title">Requisitos recomendados</h2>
          <ul className="public-list">
            <li>Conexao estavel com internet de banda larga.</li>
            <li>Microfone e camera para chamadas de voz e video.</li>
            <li>Navegador atualizado (Chrome, Edge, Firefox ou Safari).</li>
            <li>2 GB de RAM livres para uso confortavel do aplicativo.</li>
          </ul>
        </article>
      </section>
    </article>
  );
}

export function PublicSecurityPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Seguranca"
          title="Como o Messly protege os usuarios"
          description="Medidas tecnicas e operacionais para reduzir riscos, abusos e incidentes."
        />
        <FeatureGrid items={securityItems} />
      </section>

      <section className="public-section public-section--split">
        <article className="public-card">
          <h2 className="public-card__title">Sistema de denuncia</h2>
          <p className="public-card__description">
            Usuarios podem reportar comportamento abusivo, conteudo ilegal ou suspeitas de fraude para revisao da
            equipe de seguranca.
          </p>
        </article>
        <article className="public-card">
          <h2 className="public-card__title">Resposta a incidentes</h2>
          <p className="public-card__description">
            Incidentes de seguranca sao priorizados para tratamento rapido, com registro interno, mitigacao e
            comunicacao quando aplicavel.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicStatusPage() {
  const statusTimestamp = new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date());

  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Status do servico"
          title="Painel de disponibilidade da plataforma"
          description="Acompanhe o estado atual dos principais componentes do Messly."
        />

        <div className="public-grid public-grid--status">
          {statusItems.map((item) => (
            <article key={item.name} className="public-status-card">
              <div className="public-status-card__top">
                <h2 className="public-status-card__title">{item.name}</h2>
                <span className={`public-status public-status--${item.level}`}>{item.detail}</span>
              </div>
              <p className="public-status-card__text">Monitoramento continuo e verificacao automatizada.</p>
            </article>
          ))}
        </div>

        <p className="public-note">Ultima atualizacao do painel: {statusTimestamp}</p>
      </section>
    </article>
  );
}

export function PublicSupportPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Suporte"
          title="Central de ajuda do Messly"
          description="Resolva duvidas comuns e fale com nosso time quando necessario."
        />

        <div className="public-grid public-grid--cards">
          <article className="public-card">
            <h2 className="public-card__title">Problemas de login</h2>
            <p className="public-card__description">
              Confira e-mail e senha, revise bloqueio por seguranca e confirme se a conta foi verificada.
            </p>
          </article>
          <article className="public-card">
            <h2 className="public-card__title">Recuperacao de conta</h2>
            <p className="public-card__description">
              Use fluxo de recuperacao por e-mail e valide o acesso no mesmo dispositivo quando solicitado.
            </p>
          </article>
          <article className="public-card">
            <h2 className="public-card__title">Problemas com chamadas</h2>
            <p className="public-card__description">
              Verifique permissoes de microfone/camera, conexao de rede e disponibilidade de gateway de voz.
            </p>
          </article>
          <article className="public-card">
            <h2 className="public-card__title">Contato com suporte</h2>
            <p className="public-card__description">
              Fale com o time em <a href="mailto:suporte@messly.site">suporte@messly.site</a>.
            </p>
          </article>
        </div>
      </section>

      <section className="public-section">
        <h2 className="public-section__subtitle">Perguntas frequentes</h2>
        <div className="public-faq">
          <details className="public-faq__item" open>
            <summary>Como recupero minha conta?</summary>
            <p>
              Use o fluxo de recuperacao no login e siga as instrucoes recebidas por e-mail para redefinir acesso com
              seguranca.
            </p>
          </details>
          <details className="public-faq__item">
            <summary>Por que nao consigo iniciar uma chamada?</summary>
            <p>
              Valide permissoes de microfone/camera, status da conexao e disponibilidade de voz no painel de status.
            </p>
          </details>
          <details className="public-faq__item">
            <summary>Como denunciar abuso ou conteudo ilegal?</summary>
            <p>
              Envie denuncia para <a href="mailto:denuncias@messly.site">denuncias@messly.site</a> com evidencias e
              contexto.
            </p>
          </details>
        </div>
      </section>
    </article>
  );
}

export function PublicCommunityGuidelinesPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Diretrizes da Comunidade"
          title="Regras para uso seguro e respeitoso do Messly"
          description="Estas regras valem para site, aplicativo, servidores, canais, chamadas e mensagens privadas."
        />

        <article className="public-policy">
          <h2>1. Condutas proibidas</h2>
          <ul className="public-list">
            <li>Discurso de odio, discriminacao e violencia contra individuos ou grupos.</li>
            <li>Assedio, intimidacao, perseguicao, ameaca ou exposicao indevida de terceiros.</li>
            <li>Spam, automacao abusiva e envio massivo de conteudo nao solicitado.</li>
            <li>Fraude, engenharia social, phishing e tentativa de roubo de credenciais.</li>
            <li>Distribuicao de malware, links maliciosos ou arquivos com codigo nocivo.</li>
            <li>Publicacao, compartilhamento ou incentivo a conteudo ilegal.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>2. Aplicacao de punicoes</h2>
          <p>Violacoes podem resultar em uma ou mais medidas, conforme gravidade e reincidencia:</p>
          <ul className="public-list">
            <li>Aviso formal e orientacao de conduta.</li>
            <li>Suspensao temporaria de funcionalidades ou da conta.</li>
            <li>Banimento permanente da conta e bloqueio de novos acessos.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>3. Colaboracao da comunidade</h2>
          <p>
            A comunidade deve usar os canais de denuncia de boa-fe. Denuncias falsas, manipuladas ou maliciosas podem
            gerar medidas contra quem as enviar.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicTermsPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Termos de Uso"
          title="Termos de Uso da plataforma Messly"
          description={`Ultima revisao: ${POLICY_UPDATED_AT}`}
        />

        <article className="public-policy">
          <h2>1. Aceitacao dos termos</h2>
          <p>
            Ao criar conta, acessar ou usar o Messly, voce declara que leu, compreendeu e concorda com estes Termos de
            Uso e com a Politica de Privacidade.
          </p>
        </article>

        <article className="public-policy">
          <h2>2. Uso da plataforma</h2>
          <p>
            O Messly oferece chat em tempo real, mensagens privadas, servidores, canais, chamadas de voz e video,
            envio de arquivos e recursos de perfil. O uso deve seguir a legislacao brasileira e as diretrizes da
            comunidade.
          </p>
        </article>

        <article className="public-policy">
          <h2>3. Responsabilidades do usuario</h2>
          <ul className="public-list">
            <li>Fornecer informacoes verdadeiras no cadastro e manter seus dados atualizados.</li>
            <li>Manter a seguranca da conta, senha e dispositivos de acesso.</li>
            <li>Nao utilizar a plataforma para atividades ilicitas, fraudulentas ou abusivas.</li>
            <li>Respeitar direitos de terceiros e propriedade intelectual.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>4. Suspensao e encerramento de contas</h2>
          <p>
            O Messly pode limitar, suspender ou encerrar contas que violem estes termos, as diretrizes da comunidade
            ou exigencias legais, inclusive para prevencao de danos a usuarios e a plataforma.
          </p>
        </article>

        <article className="public-policy">
          <h2>5. Limitacao de responsabilidade</h2>
          <p>
            O servico e fornecido conforme disponibilidade tecnica. O Messly envidara esforcos razoaveis para manter
            estabilidade e seguranca, sem garantia absoluta de funcionamento ininterrupto ou isencao total de falhas.
          </p>
        </article>

        <article className="public-policy">
          <h2>6. Alteracoes dos termos</h2>
          <p>
            Estes termos podem ser atualizados periodicamente. Mudancas relevantes serao comunicadas por canais
            oficiais da plataforma e passarao a valer na data informada.
          </p>
        </article>

        <article className="public-policy">
          <h2>7. Legislacao aplicavel e foro</h2>
          <p>
            Estes termos sao regidos pelas leis da Republica Federativa do Brasil, incluindo Marco Civil da Internet
            (Lei no 12.965/2014) e legislacao civil aplicavel.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicPrivacyPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Politica de Privacidade"
          title="Tratamento de dados pessoais no Messly"
          description={`Ultima revisao: ${POLICY_UPDATED_AT}`}
        />

        <article className="public-policy">
          <h2>1. Dados coletados</h2>
          <p>Para operacao da plataforma, o Messly pode coletar:</p>
          <ul className="public-list">
            <li>E-mail cadastrado.</li>
            <li>Nome de usuario e nome exibido.</li>
            <li>Endereco IP de acesso.</li>
            <li>Dados de dispositivo e ambiente de uso.</li>
            <li>Mensagens enviadas na plataforma.</li>
            <li>Arquivos enviados, incluindo imagens e GIFs.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>2. Como usamos os dados</h2>
          <ul className="public-list">
            <li>Autenticacao, seguranca da conta e prevencao de fraude.</li>
            <li>Entrega de funcionalidades de chat, voz, video e compartilhamento.</li>
            <li>Melhoria de desempenho, estabilidade e experiencia de uso.</li>
            <li>Atendimento de solicitacoes de suporte e obrigacoes legais.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>3. Armazenamento e protecao</h2>
          <p>
            Os dados sao armazenados com controles de seguranca tecnicos e administrativos proporcionais ao risco,
            incluindo monitoramento, restricoes de acesso e registros operacionais.
          </p>
        </article>

        <article className="public-policy">
          <h2>4. Compartilhamento de dados</h2>
          <p>Dados podem ser compartilhados apenas quando necessario, por exemplo:</p>
          <ul className="public-list">
            <li>Com operadores e provedores de infraestrutura essenciais ao servico.</li>
            <li>Para cumprimento de obrigacao legal, ordem judicial ou requisicao de autoridade competente.</li>
            <li>Para defesa de direitos do Messly, dos usuarios e da coletividade.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>5. Direitos do titular segundo a LGPD</h2>
          <p>Nos termos da Lei no 13.709/2018 (LGPD), o usuario pode solicitar:</p>
          <ul className="public-list">
            <li>Confirmacao da existencia de tratamento.</li>
            <li>Acesso aos dados tratados.</li>
            <li>Correcao de dados incompletos, inexatos ou desatualizados.</li>
            <li>Anonimizacao, bloqueio ou eliminacao quando cabivel.</li>
            <li>Portabilidade, informacoes sobre compartilhamento e revisao de decisoes automatizadas.</li>
            <li>Revogacao de consentimento quando esta for a base legal aplicavel.</li>
          </ul>
          <p>
            Solicite pelo canal <a href="mailto:privacidade@messly.site">privacidade@messly.site</a>.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicCookiesPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Politica de Cookies"
          title="Uso de cookies no Messly"
          description={`Ultima revisao: ${POLICY_UPDATED_AT}`}
        />

        <article className="public-policy">
          <h2>1. O que sao cookies</h2>
          <p>
            Cookies sao pequenos arquivos armazenados no navegador para manter sessao, lembrar preferencias e apoiar
            seguranca e analise de uso da plataforma.
          </p>
        </article>

        <article className="public-policy">
          <h2>2. Tipos de cookies utilizados</h2>
          <ul className="public-list">
            <li>Cookies de sessao: mantem o usuario autenticado durante o uso.</li>
            <li>Cookies de autenticacao: ajudam a validar identidade e reduzir acessos indevidos.</li>
            <li>Cookies de seguranca: apoiam deteccao de abuso, fraude e comportamento suspeito.</li>
            <li>Cookies de analise: medem desempenho e uso para melhoria continua da plataforma.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>3. Gerenciamento de cookies</h2>
          <p>
            O usuario pode ajustar preferencias no navegador. A desativacao de certos cookies pode limitar recursos
            essenciais de login, seguranca e uso da plataforma.
          </p>
        </article>
      </section>
    </article>
  );
}

export function PublicContactPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Contato"
          title="Canais de contato oficiais do Messly"
          description="Use o canal correto para agilizar atendimento e encaminhamento interno."
        />

        <div className="public-grid public-grid--cards">
          <article className="public-card">
            <h2 className="public-card__title">Suporte</h2>
            <p className="public-card__description">
              Ajuda com conta, login, uso do aplicativo e dificuldades tecnicas.
            </p>
            <p className="public-card__meta">
              <a href="mailto:suporte@messly.site">suporte@messly.site</a>
            </p>
          </article>

          <article className="public-card">
            <h2 className="public-card__title">Denuncias</h2>
            <p className="public-card__description">
              Reporte assedio, phishing, fraude, malware e conteudo potencialmente ilegal.
            </p>
            <p className="public-card__meta">
              <a href="mailto:denuncias@messly.site">denuncias@messly.site</a>
            </p>
          </article>

          <article className="public-card">
            <h2 className="public-card__title">Contato legal</h2>
            <p className="public-card__description">
              Comunicacoes juridicas, notificacoes formais e assuntos regulatorios.
            </p>
            <p className="public-card__meta">
              <a href="mailto:legal@messly.site">legal@messly.site</a>
            </p>
          </article>

          <article className="public-card">
            <h2 className="public-card__title">Solicitacoes LGPD</h2>
            <p className="public-card__description">
              Direitos do titular de dados: acesso, correcao, eliminacao, portabilidade e demais pedidos.
            </p>
            <p className="public-card__meta">
              <a href="mailto:privacidade@messly.site">privacidade@messly.site</a>
            </p>
          </article>
        </div>
      </section>
    </article>
  );
}

export function PublicIntellectualPropertyPage() {
  return (
    <article className="public-page">
      <section className="public-section">
        <PublicSectionHeader
          eyebrow="Propriedade Intelectual"
          title="Direitos de propriedade intelectual do Messly"
          description={`Ultima revisao: ${POLICY_UPDATED_AT}`}
        />

        <article className="public-policy">
          <h2>1. Elementos protegidos</h2>
          <p>Sao protegidos por legislacao de propriedade intelectual, entre outros:</p>
          <ul className="public-list">
            <li>Nome comercial Messly.</li>
            <li>Logotipo e marcas visuais.</li>
            <li>Design da plataforma e interface.</li>
            <li>Codigo-fonte e arquitetura do sistema.</li>
            <li>Elementos visuais, textos, componentes e materiais oficiais.</li>
          </ul>
        </article>

        <article className="public-policy">
          <h2>2. Uso sem autorizacao</h2>
          <p>
            E proibido copiar, reproduzir, distribuir, modificar, explorar comercialmente ou criar obras derivadas
            sem autorizacao expressa do Messly.
          </p>
        </article>

        <article className="public-policy">
          <h2>3. Medidas de protecao</h2>
          <p>
            O uso indevido pode resultar em medidas administrativas e judiciais cabiveis para protecao dos direitos da
            plataforma.
          </p>
        </article>
      </section>
    </article>
  );
}
