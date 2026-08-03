# red-dev vs. Omakub: análise comparativa e oportunidades

## Data

2026-08-03

## Query

Comparar o que o Omakub entrega hoje com o que o red-dev entrega, validar a tese de que o red-dev é uma evolução espiritual multiplataforma, identificar lacunas para o setup inicial dos colaboradores da RedDB.io e propor um caminho de produto para instalação, experiência de desktop, agentes, ferramentas internas e upgrades.

## Escopo

- red-dev no commit `e7757978783fc96ec8871e5efdeddc93ee8adc06`, versão de pacote `0.19.0`.
- Última release estável publicada do red-dev no momento da pesquisa: `v0.17.1`.
- Omakub no commit `c873902f1a5d8b0f54e2e52d565a77274a5941ff`, versão/release `1.5.0`.
- Ubuntu, WSL, Windows e a aspiração de suporte a macOS.
- Instalação inicial, convergência, atualização, temas, fontes, hotkeys, tiling, aplicativos, linguagens, bancos, agentes de IA e ferramentas RedDB.
- Apenas documentação, repositórios e releases oficiais foram usados como fontes externas.

Não fazem parte deste estudo testes manuais em hardware limpo, avaliação subjetiva de cada tema nem a escolha final de ferramentas nativas para tiling e launcher no macOS.

## Resumo executivo

A tese de “evolução espiritual do Omakub” é defensável, mas ainda está parcialmente realizada.

O red-dev já tem uma fundação de engenharia mais ambiciosa: modelo tipado de plataforma e capacidades, binários compilados, providers por plataforma, instalação convergente e reexecutável, `plan`, `doctor`, isolamento de falhas, preferências persistentes, migrações, integração WSL/Windows e uma oferta muito mais orientada a agentes e ao ecossistema RedDB. Isso é uma evolução real do modelo de scripts Bash focados em Ubuntu do Omakub.

O Omakub, porém, ainda entrega uma experiência de desktop Linux mais completa e coerente no primeiro dia. Ele configura GNOME, workspaces, tiling, launcher, dock, atalhos, aplicativos, LazyVim, VS Code, web apps, linguagens e bancos como uma experiência única. O red-dev tem ótimas peças, mas várias ainda não formam uma jornada ponta a ponta.

Os cinco bloqueadores principais são:

1. `red-dev update` não atualiza o próprio binário do red-dev.
2. macOS não é suportado e hoje pode cair incorretamente em providers Ubuntu; deve falhar de forma explícita até existir um provider Darwin real.
3. Pi não está no catálogo e Hermes é instalado sem receber a integração RedSkills; a promessa de ambiente de agentes uniforme ainda cobre efetivamente apenas Claude Code, Codex e OpenCode.
4. O desktop Ubuntu não porta nem valida a camada que torna o Omakub memorável: hotkeys, tiling, workspaces, dock, launcher e extensões GNOME.
5. A experiência editorial e de workstation está incompleta: não há bootstrap LazyVim, template completo de VS Code, seletor de bancos e o módulo de web apps não está conectado a nenhum comando ou menu.

A recomendação não é copiar indiscriminadamente todos os aplicativos do Omakub. É preservar a arquitetura convergente do red-dev e organizar o produto em perfis declarativos — por exemplo `minimal`, `desktop`, `reddb-employee` e `ai-heavy` — com uma camada semântica comum para temas, fontes, hotkeys, ferramentas, agentes e verificações de prontidão.

## Fontes oficiais

### red-dev

- [README e promessa de produto](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/README.md)
- [Detecção de plataforma e capacidades](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/platform.ts)
- [Manifesto de ferramentas e seleção de providers](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts)
- [Catálogo e instalação de agentes](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts)
- [Providers de instalação e atualização](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/providers.ts)
- [CLI de atualização](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/commands/update.ts)
- [Migrações](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/migrations.ts)
- [Hotkeys](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/hotkeys.ts)
- [Web apps](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/webapps.ts)
- [Release estável v0.17.1](https://github.com/reddb-io/red-dev/releases/tag/v0.17.1)

### Omakub

- [Site oficial](https://omakub.org/)
- [Manual oficial](https://learn.omacom.io/1/read)
- [Repositório oficial](https://github.com/basecamp/omakub)
- [Instalador principal](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install.sh)
- [Menu principal](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub)
- [Configuração de GNOME e hotkeys](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/defaults)
- [Catálogo de temas](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/themes)
- [Atualização e migrações](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/update.sh)
- [Release v1.5.0](https://github.com/basecamp/omakub/releases/tag/v1.5.0)

### Pi e Hermes

- [Pi Coding Agent — README oficial](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)
- [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [Hermes — instalação](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/getting-started/installation.md)
- [Hermes — skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [Hermes — MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md)

## Hotlinks

- [README do red-dev](../../README.md)
- [Plataformas](../../src/platform.ts)
- [Manifesto](../../src/manifest.ts)
- [Agentes](../../src/agents.ts)
- [Providers](../../src/providers.ts)
- [Hotkeys](../../src/hotkeys.ts)
- [Web apps](../../src/webapps.ts)
- [Migrações](../../src/migrations.ts)

## Comparação de produto

| Dimensão | Omakub | red-dev hoje | Veredito |
|---|---|---|---|
| Plataforma | Ubuntu GNOME x86_64; foco deliberadamente estreito | Ubuntu 24.04, caminho para 26.04, WSL e Windows x64; macOS aspiracional | red-dev tem a arquitetura mais ampla, mas ainda não entrega macOS/ARM |
| Forma de distribuição | Checkout Git + scripts Bash | Binários compilados Linux/Windows e manifesto tipado | red-dev |
| Reexecução | Instalação linear com `set -e` | Convergência idempotente, etapas independentes, `plan` e `doctor` | red-dev |
| Atualização | Atualiza o próprio checkout e executa migrações | Atualiza sistema, ferramentas e RedSkills, mas não o próprio red-dev | Empate com lacuna crítica no red-dev |
| Desktop Linux | GNOME completo: extensões, tiling, dock, launcher, workspaces e hotkeys | Apps, temas e fontes; configuração GNOME ainda não portada/validada | Omakub |
| Windows/WSL | Não é objetivo | Integração de host, config compartilhada, winget e hotkeys básicos | red-dev |
| Temas | Dez temas sobre terminal, editor e GNOME | Os mesmos dez, mais várias superfícies CLI e agentes | red-dev em cobertura; Omakub em acabamento GNOME |
| Fontes | Quatro famílias, tamanhos configuráveis | Quatro famílias, tamanhos persistentes 7–14 | Equivalentes, com escolhas de família diferentes |
| Editor | Neovim/LazyVim e VS Code configurados | Instala Neovim/VS Code e aplica temas, sem baseline completo | Omakub |
| Linguagens | Ruby/Node e seleção de Go, PHP, Python, Elixir, Rust e Java | Node, Bun, Deno, Python, Go, Rust, Ruby e Java via mise | red-dev em runtimes modernos; Omakub inclui PHP/Elixir |
| Bancos | MySQL, Redis e PostgreSQL selecionáveis via Docker | Sem jornada de bancos/serviços | Omakub |
| Aplicativos | Catálogo amplo de workstation | Catálogo menor e centrado em desenvolvimento/RedDB | Omakub em abrangência; red-dev tem melhor identidade interna |
| Web apps | Integrados ao menu e ao desktop | Implementação existe, mas está sem rota de CLI/menu e é Linux-only | Omakub |
| Agentes | Não é o centro do produto | Dez opções, RedSkills em três hosts, extensões RedDB | red-dev, com lacunas Pi/Hermes |
| Ferramentas RedDB | Não se aplica | `red`, `tq`, red-request, dit e red-ui conforme plataforma | red-dev |
| Diagnóstico | Scripts/migrações, sem modelo de drift equivalente | `doctor`, capacidades, providers e preferências persistentes | red-dev |

## Principais achados

### 1. A vantagem estrutural do red-dev é real

O Omakub é um produto vertical: escolhe Ubuntu GNOME e o transforma profundamente. Essa restrição é responsável por boa parte de sua coerência. O instalador oficial valida Ubuntu e arquitetura x86 e executa scripts Bash em sequência.

O red-dev separa plataforma, ambiente e capacidades; usa providers diferentes para `apt`, `winget`, GitHub Releases e instaladores próprios; persiste preferências e migrações; e trata WSL e Windows como lados coordenados de uma mesma estação. O desenho permite crescer sem duplicar o produto inteiro por sistema operacional.

Essa vantagem deve ser protegida. Portar scripts ad hoc do Omakub diretamente enfraqueceria o principal diferencial do red-dev. Cada nova entrega deveria entrar no mesmo modelo de manifesto, capacidade, ownership, convergência e diagnóstico.

### 2. macOS ainda não é uma plataforma do produto

`platform.ts` reconhece `darwin`, mas não existe ambiente Darwin nem coluna de provider macOS no manifesto. A seleção atual escolhe `u24` para qualquer sistema não Windows que não caia no ramo Ubuntu 26. Em outras palavras, macOS não apenas está ausente: sem uma guarda adicional, pode receber uma tentativa de instalação com providers Ubuntu.

Os bootstraps e releases reforçam isso: há caminhos Linux/WSL e Windows x64, sem artefatos macOS x64/arm64. O primeiro conserto deve ser falhar fechado e explicar “macOS ainda não suportado”. Só depois devem entrar Homebrew/casks, caminhos de configuração, bootstrap, temas, fontes, hotkeys e artefatos universais.

### 3. A atualização tem um buraco no componente mais importante

O comando `red-dev update` faz upgrade do sistema por `apt` ou `winget`, atualiza RedSkills e converge os itens instalados. Ele não baixa uma nova release do próprio red-dev.

O Omakub atualiza o próprio checkout com Git e executa migrações posteriores ao commit anterior. O red-dev já possui uma infraestrutura de migrações melhor tipada, mas ela só chega ao usuário se o binário novo for instalado por outra via.

Uma trilha de upgrade confiável precisa incluir:

- descoberta de canal e versão (`stable`, opcionalmente `preview`);
- download do artefato correto para sistema e arquitetura;
- validação por checksum e, idealmente, assinatura;
- troca atômica do binário;
- execução de migrações;
- rollback para o binário anterior;
- `doctor` detectando divergência entre binário, manifesto e versão instalada de RedSkills.

### 4. “Todo agente pronto” ainda significa três hosts

O catálogo do red-dev oferece Claude Code, Codex, OpenCode, Gemini, T3 Code, Herdr, OpenClaw, Hermes, Claude Desktop e Codex Desktop. Pi não está presente.

A integração RedSkills está codificada para Claude Code, Codex e OpenCode. Hermes pode ser instalado, mas não recebe o shared skills directory nem configuração MCP do RedSkills. Isso cria uma diferença importante entre “agente instalado” e “agente corporativo pronto”.

As fontes oficiais mostram um caminho prático:

- Pi descobre skills em `~/.agents/skills/`, além dos diretórios próprios, e aceita packages para distribuir skills, extensions, prompts e temas. A primeira integração pode compartilhar as skills; uma integração completa pode usar um package/extensão para hooks, MCP e tema.
- Hermes permite declarar diretórios externos de skills em `~/.hermes/config.yaml` e possui configuração MCP nativa. Portanto, pode apontar para `~/.agents/skills` e receber os servidores RedSkills sem duplicar o conteúdo.

O modelo recomendado é substituir a lista rígida por um `SkillHostAdapter` com operações comuns: detectar, instalar, conectar o diretório compartilhado, configurar MCP/hooks/extensões, medir versão/frescor e executar uma prova de saúde.

### 5. Omakub vence na experiência integrada de desktop Linux

O Omakub configura seis workspaces fixos, navegação por teclado, atalhos para terminal/browser/launcher, favoritos do dock e extensões como Tactile, Just Perfection, Blur My Shell, Space Bar, Undecorate e TopHat. Isso não é um conjunto de detalhes isolados; é um modelo consistente de interação.

No red-dev, a camada de hotkeys implementada hoje cobre dois atalhos Windows para abrir terminal. O README reconhece que hotkeys, extensões e dock do GNOME ainda não foram portados e que o desktop Ubuntu não foi validado em hardware real.

A oportunidade é mais forte que uma cópia de teclas: criar um catálogo semântico de ações, por exemplo `terminal.new`, `terminal.workspace`, `launcher.open`, `window.tile.left`, `workspace.goto.1` e `screenshot.region`. Cada plataforma recebe bindings equivalentes, validação de conflitos e uma cheat sheet gerada. Assim, a memória muscular permanece coerente mesmo quando GNOME, PowerToys e o gerenciador escolhido no macOS usam formatos diferentes.

### 6. Temas e fontes são um ponto forte, mas precisam virar contrato

Os dois projetos oferecem hoje dez famílias de tema: Tokyo Night, Catppuccin, Gruvbox, Everforest, Kanagawa, Matte Black, Nord, Osaka Jade, Ristretto e Rose Pine.

O red-dev aplica o tema a zellij, btop, Neovim quando já configurado, VS Code, bat, delta, lazygit, OpenCode, Herdr e superfícies do sistema operacional. A cobertura de ferramentas é excelente. O Omakub aplica de forma particularmente coesa ao GNOME, terminal, zellij, Neovim, btop, TopHat, VS Code e wallpaper.

Para sustentar a expansão, o tema deve ser tratado como contrato de tokens e capacidades, não apenas como uma coleção de arquivos. Cada superfície deveria declarar suporte, ownership, estratégia de merge e verificação. Pi, Hermes, macOS, PowerToys/AeroSpace e wallpapers por plataforma entram como adapters desse contrato.

### 7. A experiência de editor está abaixo da promessa de “setup sensacional”

O Omakub instala uma configuração funcional de Neovim baseada em LazyVim e configura VS Code. O red-dev instala os executáveis e sabe tematizar, mas só toca o Neovim quando uma configuração já existe. Não há bootstrap de um baseline editorial nem um template completo e governado de VS Code.

Para um colaborador novo, “editor instalado” não equivale a “editor pronto”. O comportamento seguro é:

- quando não existe configuração, instalar um starter RedDB versionado;
- quando existe, nunca sobrescrever: mostrar plano, oferecer adoção e fazer merge apenas de campos de propriedade explícita;
- separar baseline corporativo, preferências pessoais e estado gerado;
- testar reexecução e upgrade do template.

### 8. Aplicativos, bancos e web apps não formam uma jornada única

O Omakub oferece seleção inicial de apps, linguagens e bancos. Seu catálogo inclui browser, password manager, comunicação, mídia, escritório, screenshots, VPN, editores e ferramentas de desenvolvimento.

O red-dev possui um conjunto moderno de CLI, ótimos runtimes e as ferramentas internas RedDB, mas não há seletor de bancos/serviços. Também existe um módulo com ChatGPT, Claude, Google Photos, Contacts, Tailscale e GitHub como web apps, porém ele não é chamado por comando ou menu e só gera atalhos Linux.

Copiar todo o catálogo aumentaria custo de manutenção e opinião indesejada. Perfis resolvem melhor:

- `minimal`: shell, terminal, Git, mise e CLI essenciais;
- `desktop`: apps, fonts, themes, hotkeys, editor e web apps;
- `reddb-employee`: desktop + stack RedDB + agentes aprovados + configurações corporativas;
- `ai-heavy`: conjunto ampliado de agentes, runtimes e extensões.

O primeiro run seleciona um perfil, permite diferenças e grava a intenção. Atualizações posteriores reconciliam essa intenção sem transformar preferências pessoais em drift.

### 9. A stack RedDB é o diferencial mais valioso e deve ter SLO de prontidão

O red-dev já distribui `red`, `tq`, red-request, dit e red-ui, além de RedSkills e extensões. Esse é o ponto que o transforma de “dotfiles sofisticados” em plataforma de onboarding da companhia.

Hoje a disponibilidade varia por plataforma, com red-ui limitado a Linux e sem providers macOS. A instalação precisa terminar com um relatório de readiness, não apenas com processos bem-sucedidos:

- cada CLI selecionada responde a `--version` ou `--help`;
- cada app desktop selecionado possui artefato compatível e consegue iniciar;
- Docker está ativo;
- cada agente selecionado enxerga a mesma versão de RedSkills;
- MCPs obrigatórios inicializam;
- autenticações pendentes aparecem como ações humanas claras, sem armazenar segredos no red-dev;
- skips têm motivo explícito e distinguem “não escolhido”, “não suportado” e “falhou”.

### 10. A validação real precisa alcançar a ambição da matriz

O próprio README registra limitações de validação: Ubuntu desktop e Ubuntu 26 ainda não foram exercitados como alvo completo, e o bootstrap Windows não foi validado em uma máquina totalmente limpa. As releases atuais cobrem apenas Linux x64 e Windows x64.

O contrato mínimo de CI/E2E por alvo deve ser:

1. máquina limpa;
2. `plan` antes da instalação;
3. instalação do perfil;
4. segunda instalação com zero mudanças inesperadas;
5. `doctor` verde;
6. troca de tema/fonte e verificação das superfícies;
7. atualização de N-1 para atual;
8. rollback testado;
9. smoke test dos agentes e ferramentas RedDB.

## Detalhes de API, CLI e configuração

### CLI proposta

```text
red-dev self-update [--channel stable|preview] [--version X]
red-dev profile list
red-dev profile show reddb-employee
red-dev profile apply reddb-employee [--plan]
red-dev agents doctor
red-dev tools doctor
red-dev hotkeys list
red-dev hotkeys apply [--plan]
red-dev webapps
red-dev doctor --readiness
red-dev rollback
```

`red-dev update` deveria orquestrar `self-update`, migrações e convergência, preservando um comando único para o caminho feliz.

### Contratos internos propostos

```ts
interface PlatformProvider {
  platform: "ubuntu" | "windows" | "macos";
  architecture: "x64" | "arm64";
  detect(): Promise<CapabilitySet>;
  plan(item: DesiredItem): Promise<PlanStep[]>;
  apply(step: PlanStep): Promise<Result>;
  verify(item: DesiredItem): Promise<HealthResult>;
}

interface SkillHostAdapter {
  id: "claude" | "codex" | "opencode" | "hermes" | "pi";
  detect(): Promise<HostState>;
  install(): Promise<Result>;
  wireSharedSkills(path: string): Promise<Result>;
  configureIntegrations(): Promise<Result>;
  verify(): Promise<HealthResult>;
}

interface SemanticHotkey {
  action: string;
  description: string;
  bindings: Partial<Record<"gnome" | "windows" | "macos", string>>;
}
```

### Propriedade de configuração

Todo adapter deve declarar uma destas estratégias:

- `owned`: arquivo inteiramente gerado pelo red-dev;
- `merged`: apenas chaves explícitas são gerenciadas;
- `adopted`: arquivo existente é importado após confirmação;
- `external`: red-dev apenas verifica e orienta.

Essa distinção é essencial para upgrades seguros de VS Code, Neovim, configurações de agentes, GNOME, PowerToys e macOS.

## Notas de versão

- O checkout analisado do red-dev declara `0.19.0`, enquanto a última release estável encontrada é `v0.17.1`. O relatório avalia o código atual e sinaliza a diferença porque ela afeta a experiência de upgrade.
- O Omakub analisado está em `1.5.0`, com release oficial correspondente.
- A documentação manual do Omakub pode ficar atrás do repositório em inventários como quantidade de temas; quando houve divergência, o código fixado no commit analisado foi considerado a fonte de verdade.
- Pi atualmente é publicado sob `earendil-works/pi`; links ou pacotes históricos podem apontar para nomes anteriores.

## Gotchas

- Multiplataforma não significa paridade artificial. Alguns recursos devem ter equivalentes semânticos, não implementações idênticas.
- Não configurar `darwin` para “usar o que funcionar do Linux”. Providers devem falhar fechados para impedir chamadas `apt` em macOS.
- Compartilhar o diretório de skills não garante integração total de RedSkills; MCP, hooks, plugins e ciclo de atualização precisam de verificação por host.
- Alterar dotfiles existentes silenciosamente destruiria confiança. `plan`, ownership e adoção explícita são requisitos de produto.
- Muitos aplicativos no core tornam a instalação lenta e frágil. Perfis devem manter o caminho mínimo pequeno.
- Hotkeys globais conflitam com sistema, acessibilidade e apps. O schema precisa detectar colisões antes de aplicar.
- Um download bem-sucedido não prova prontidão. O `doctor` deve testar o comportamento observável.
- Atualização automática sem rollback transforma um instalador em ponto único de falha da estação de trabalho.

## Questões em aberto

1. Qual é o baseline obrigatório do perfil `reddb-employee` e quais itens permanecem opcionais?
2. O macOS deve padronizar Bash para paridade, adotar Zsh nativo ou oferecer ambos sob o mesmo contrato?
3. Qual combinação macOS será oficial para tiling e launcher? Essa decisão merece um spike com hardware real.
4. A RedDB quer governar integralmente o template de Neovim/VS Code ou apenas distribuir starters atualizáveis?
5. Quais MCPs e autenticações são obrigatórios por agente, e quais são pessoais?
6. Releases preview serão consumidas por todos ou apenas por um canal interno?
7. O perfil corporativo deve instalar apps de segurança/VPN/password manager ou somente preparar os hooks de integração?
8. Quais métricas de onboarding podem ser coletadas de forma opt-in e sem expor informações da máquina?

## Notas fonte a fonte

### red-dev

- O README define cinco alvos atuais/planejados, comandos, stack principal, agentes, temas, ferramentas RedDB e limitações conhecidas.
- `platform.ts` comprova a presença de `darwin` no tipo de OS, mas ausência de um ambiente/provider macOS.
- `manifest.ts` comprova as colunas Ubuntu 24, Ubuntu 26 e Windows e a seleção inadequada de Ubuntu para todo não Windows.
- `providers.ts` e o comando de update mostram upgrades de sistema/ferramentas sem troca do binário red-dev.
- `agents.ts` comprova o catálogo atual e a ausência de Pi.
- A integração de RedSkills limita hosts a Claude, Codex e OpenCode; os caminhos adicionais cobrem extensão VS Code e plugin Herdr.
- `hotkeys.ts` cobre apenas os dois atalhos Windows atuais.
- `webapps.ts` contém a implementação, mas não há referência a ela em comando/menu.
- `migrations.ts` demonstra que já existe uma base apropriada para upgrades de estado.

### Omakub

- README/site/manual definem a proposta deliberadamente opinionada para Ubuntu.
- `install.sh` demonstra o pipeline Bash linear e a distinção terminal/desktop.
- Os defaults do repositório mostram GNOME, extensões, dock, workspaces e hotkeys.
- Os menus mostram seleção de apps, linguagens, bancos, temas, fontes, install/uninstall e update.
- O catálogo de temas no commit analisado contém dez temas.
- O fluxo de update usa o checkout Git e executa migrações por timestamp/commit.

### Pi

- O README oficial documenta instalação, diretórios de skills e modelo extensível.
- A documentação de packages mostra distribuição e atualização de skills, extensions, prompts e temas.
- A filosofia do projeto não inclui MCP no core; uma extensão é o caminho para integração adicional.

### Hermes

- A documentação oficial cobre Linux, macOS, WSL e Windows.
- Skills externas podem ser declaradas em configuração, permitindo compartilhar `~/.agents/skills`.
- MCPs são configuráveis nativamente, oferecendo um caminho direto para os serviços RedSkills.

## Próximos passos recomendados

### P0 — tornar a promessa honesta e atualizável

1. Fazer macOS falhar fechado imediatamente; nunca selecionar provider Ubuntu para Darwin.
2. Implementar `self-update` atômico com checksum, rollback e canal de release.
3. Incorporar `self-update` ao caminho feliz de `red-dev update`.
4. Gerar uma matriz pública de capacidade/plataforma a partir do manifesto.
5. Adicionar `doctor --readiness` e distinguir installed/configured/healthy/auth-required.

### P0 — completar o perfil RedDB Day One

1. Definir e versionar o perfil `reddb-employee`.
2. Adicionar Pi ao catálogo.
3. Introduzir `SkillHostAdapter` para Claude, Codex, OpenCode, Hermes e Pi.
4. Ligar Hermes ao diretório compartilhado e aos MCPs RedSkills.
5. Ligar Pi às shared skills e construir package/extensão para a integração completa.
6. Garantir providers e health checks para `red`, `tq`, red-request, dit, red-ui e RedSkills em cada alvo suportado.

### P1 — alcançar o acabamento do Omakub no Linux

1. Portar a intenção de GNOME do Omakub para adapters convergentes do red-dev.
2. Criar o schema semântico de hotkeys e cheat sheet gerada.
3. Entregar tiling, workspaces, launcher e dock como parte do perfil desktop.
4. Bootstrap seguro de LazyVim e baseline VS Code quando não houver configuração.
5. Conectar `webapps.ts` ao CLI/menu e adicionar adapters Windows/macOS.
6. Oferecer bancos/serviços de desenvolvimento como módulo opcional.

### P1 — entregar macOS de verdade

1. Criar ambiente/capacidades Darwin e providers Homebrew/cask/builtin/GitHub Releases.
2. Publicar x64 e arm64 com bootstrap e checksums.
3. Adaptar caminhos, shell, terminal, fontes, temas e aplicativos.
4. Fazer spike e ADR para tiling, launcher e hotkeys.
5. Portar toda a stack RedDB antes de declarar paridade do perfil corporativo.

### P2 — comprovar e sustentar

1. CI/E2E em Ubuntu 24/26, WSL, Windows e macOS Intel/ARM.
2. Testar instalação limpa, segunda convergência, N-1 update, rollback e doctor.
3. Gerar docs, inventários de tema/app/agente e matriz de suporte a partir do código.
4. Estabelecer SLOs de onboarding:
   - perfil pronto em até 30 minutos, excluindo downloads e autenticações humanas;
   - segunda convergência sem alterações inesperadas;
   - `doctor` verde após setup;
   - todo agente escolhido enxerga a versão esperada de RedSkills;
   - toda ferramenta RedDB escolhida passa smoke test;
   - atualização N-1 e rollback comprovados em cada plataforma.

## Conclusão

O red-dev não precisa competir com o Omakub pelo número de scripts ou aplicativos. Sua oportunidade é ser a versão governada, verificável e multiplataforma da mesma ideia: uma estação de desenvolvimento excelente como produto contínuo.

Hoje ele já tem a melhor fundação para isso. Para transformar a tese em experiência, a prioridade deve ser fechar o ciclo completo — instalar, configurar, verificar, atualizar e recuperar — primeiro no perfil RedDB Day One, depois no desktop Linux e finalmente no macOS. Quando agentes, ferramentas internas, temas, fontes, hotkeys e editores forem expressos como contratos declarativos sobre essa fundação, o red-dev deixará de ser apenas uma evolução espiritual do Omakub e passará a ser uma plataforma de workstation que o Omakub, por escolha de escopo, não pretende ser.
