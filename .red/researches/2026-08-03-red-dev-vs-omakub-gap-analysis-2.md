# red-dev vs. Omakub — auditoria técnica aprofundada

Date: 2026-08-03

Query: investigar profundamente o red-dev e o Omakub, comparar tudo o que cada produto instala e configura, cobrir programas, assets, temas, fontes, hotkeys, tiling, agentes, ferramentas RedDB e upgrades, e encontrar gaps e oportunidades para que o red-dev entregue uma experiência de workstation superior em Linux, WSL, Windows e macOS.

Scope: código e assets do red-dev no commit `e7757978783fc96ec8871e5efdeddc93ee8adc06`; código e assets do Omakub no commit `c873902f1a5d8b0f54e2e52d565a77274a5941ff`; releases oficiais vigentes em 2026-08-03; inventários completos dos manifests e scripts; comportamento por plataforma; experiência de instalação, configuração e atualização. Não foram executadas instalações destrutivas em máquinas limpas. Quando o código e a documentação divergiram, o código fixado por commit foi tratado como comportamento de produto e a divergência foi registrada.

## Executive Summary

O red-dev já é uma evolução arquitetural do Omakub, mas ainda não é uma evolução completa da experiência do Omakub.

Ele possui uma base melhor para um produto corporativo multiplataforma: manifesto tipado com 56 itens, providers explícitos, binários compilados, convergência reexecutável, falhas isoladas por item, `plan`, `doctor`, migrações ledgered, configuração compartilhada WSL/Windows, canais stable/next, ferramentas RedDB e onboarding de agentes. O Omakub é mais estreito: Ubuntu GNOME x86, checkout Git e scripts Bash imperativos.

Entretanto, o Omakub ainda ganha com folga naquilo que o usuário vê e sente no primeiro dia:

- instala um workstation desktop completo, não somente ferramentas de desenvolvimento;
- instala e configura Chrome, VS Code, LazyVim, launcher, screenshots, comunicação, escritório e utilidades;
- entrega tiling de janelas via GNOME/Tactile e tiling de terminal via Zellij;
- configura seis workspaces, dock, app grid, extensões e dezenas de atalhos úteis;
- possui dez bundles de tema completos, cada um com Alacritty, Zellij, btop, Neovim, VS Code, GNOME, TopHat e wallpaper;
- inclui dez wallpapers e nove ícones de aplicação no checkout;
- oferece bancos Docker e linguagens durante o primeiro run;
- atualiza o próprio produto e executa migrações.

O red-dev tem dez temas e alcança mais superfícies CLI, mas a auditoria encontrou defeitos relevantes:

1. Sete temas não instalam o plugin Neovim correspondente; alguns também usam o nome de colorscheme errado.
2. Rose Pine é uma paleta clara, mas GNOME e Windows são forçados para dark mode.
3. Osaka Jade não tem integração VS Code; o Omakub usa Ocean Green como aproximação explícita.
4. Apenas três dos dez wallpapers gerados estão versionados, apesar dos comentários dizerem que todos estão.
5. `fzfColors()` existe, mas não é conectado a nenhuma configuração.
6. No Windows nativo, o ramo de tema ignora Zellij, btop, bat, delta, lazygit, OpenCode e Herdr.
7. A fonte escolhida não é instalada no Ubuntu desktop nem no Windows nativo.
8. Trocar tema ou convergir novamente pode voltar a fonte para FiraCode e tamanho 11 porque preferências persistidas não alimentam o `ApplyContext`.

Também há gaps de catálogo e assets que mudam a prioridade do roadmap:

- red-ui já publica Windows x64 e macOS Intel/ARM, mas o manifesto ainda declara que não existe build Windows;
- todas as ferramentas RedDB principais já possuem assets macOS; `red`, `tq` e `dit` também possuem Linux ARM;
- RedSkills v2 já suporta Pi, mas red-dev não instala Pi e seu `doctor` só reconhece Claude, Codex e OpenCode;
- RedSkills v3 adiciona Gemini, enquanto red-dev continua chamando o instalador v2;
- Hermes ainda não é um host oficial RedSkills, embora suporte skills externas e MCP nativamente;
- macOS é reconhecido como `darwin`, mas cai no provider Ubuntu 24 e não possui bootstrap nem release asset.

A ordem recomendada é:

1. corrigir as falsas promessas e os defeitos de tema/fonte/provider;
2. completar um perfil `reddb-employee` verificável;
3. entregar desktop Linux no nível de acabamento do Omakub;
4. adicionar macOS como plataforma real, aproveitando Homebrew e os assets RedDB já existentes;
5. transformar hotkeys, temas, fontes, apps e agentes em contratos declarativos com testes E2E.

## Official Sources

### red-dev

- [README no commit auditado](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/README.md) — promessa de produto, comandos e limitações declaradas.
- [Manifesto completo](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts) — fonte de verdade dos 56 itens e seus providers.
- [Plataformas e capacidades](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/platform.ts) — detecção de Linux, Windows, Darwin, WSL e desktop/server.
- [Agentes e integração RedSkills](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts) — catálogo, installers e hosts reconhecidos.
- [Paletas de tema](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/themes.ts) — dez temas e paletas ANSI.
- [Aplicação de temas](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-apply.ts) — superfícies e diferenças por plataforma.
- [Temas de VS Code e GNOME](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-editors.ts) — extensions, labels, accents e política de merge.
- [Temas de CLI e agentes](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/theme-cli.ts) — bat, delta, lazygit, OpenCode, Herdr e função fzf não conectada.
- [Wallpapers](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/wallpaper.ts) — geração 2560×1440 e aplicação GNOME/Windows.
- [Fontes e Windows Terminal](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/wsl.ts) — famílias Nerd Font, registro Windows e config do terminal.
- [Hotkeys Windows](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/hotkeys.ts) — dois atalhos globais.
- [Config Zellij](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/config/zellij/config.kdl) — tabela de teclas, sessão e clipboard.
- [Web apps](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/webapps.ts) — catálogo existente, mas não roteado no CLI.
- [Providers e update](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/providers.ts) — downloads, unpack, apt/winget e upgrade do sistema.
- [Release pipeline](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/.github/workflows/release.yml) — Linux/Windows x64, checksums e attestations.
- [Release v0.17.1](https://github.com/reddb-io/red-dev/releases/tag/v0.17.1) — última stable no momento da pesquisa.

### Omakub

- [Repositório oficial](https://github.com/basecamp/omakub) — fonte primária do produto.
- [README no commit auditado](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/README.md) — escopo Ubuntu e instalação.
- [Bootstrap](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/boot.sh) — clone do checkout e seleção de ref.
- [Instalador principal](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install.sh) — fluxo terminal/desktop e política `set -e`.
- [Programas de terminal](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/terminal) — bibliotecas, CLIs, runtimes e bancos.
- [Programas de desktop](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop) — apps, optional apps e configuração GNOME.
- [Hotkeys GNOME](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-hotkeys.sh) — bindings de workspaces, apps, launcher e utilidades.
- [Extensões GNOME e Tactile](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-extensions.sh) — sete extensões e layout de tiling.
- [Dock](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-dock.sh) — favoritos curados.
- [Bundles de tema](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/themes) — dez temas com oito assets cada.
- [Mudança de tema](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/theme.sh) — aplicação coordenada das superfícies.
- [Fontes](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/font.sh) — quatro famílias e integração GNOME/Alacritty/VS Code.
- [Update](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/update.sh) e [migração](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/bin/omakub-sub/migrate.sh) — self-update Git e migrations.
- [Manual de hotkeys](https://learn.omacom.io/1/read/29/hotkeys) — referência de uso oficial.
- [Manual de tiling](https://learn.omacom.io/1/read/39/tiling) — modelo de janelas e Tactile.
- [Manual de temas](https://learn.omacom.io/1/read/6/themes) — intenção de experiência; contém inventário desatualizado.
- [Manual de fontes](https://learn.omacom.io/1/read/16/fonts) — famílias e comportamento de tamanho.
- [Manual de update](https://learn.omacom.io/1/read/32/updating) — fluxo esperado pelo usuário.
- [Release v1.5.0](https://github.com/basecamp/omakub/releases/tag/v1.5.0) — última stable no momento da pesquisa.

### Iniciativa de agentes da 37signals/DHH

- [house-skills no commit auditado](https://github.com/basecamp/house-skills/tree/d2d85abe034b0e6d4bfc3dbef646c427b05a385f) — conjunto opinionado de práticas, skills e plugins internos da 37signals.
- [README do house-skills](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/README.md) — canais de distribuição e catálogo público.
- [Skill agents-md](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/ai/skills/agents-md/SKILL.md) — política para contexto always-on, auditoria e progressive disclosure.
- [Skill skill-crafting](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/ai/skills/skill-crafting/references/guide.md) — flywheel de co-desenvolvimento, exemplares e evals.
- [Ralph–Lisa loop](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/plugins/dev/skills/ralph-lisa-loop/references/guide.md) — loop planner/implementer/self-review/Codex, rope length e close gate.
- [Trust boundaries do repositório](https://github.com/basecamp/house-skills/blob/d2d85abe034b0e6d4bfc3dbef646c427b05a385f/AGENTS.md) — output externo é evidência, não instrução executável.
- [basecamp-cli no commit auditado](https://github.com/basecamp/basecamp-cli/tree/3e86a0f0f50772eddbe0a607a5fc5c9c3809d7cf) — exemplo concreto de produto tornado agent-accessible por CLI estruturado.
- [Basecamp Agent Skill publicada](https://github.com/basecamp/skills/blob/024f56a8e058c9fecdeea6aef9eb5e02c6f10022/skills/basecamp/SKILL.md) — superfície operacional gerada junto ao CLI.
- [Install document para agentes](https://github.com/basecamp/skills/blob/024f56a8e058c9fecdeea6aef9eb5e02c6f10022/install.md) — instalação autônoma com objetivo, critérios de conclusão e verificações.
- [Marketplace oficial 37signals](https://github.com/basecamp/claude-plugins) — plugins de Basecamp, HEY, Fizzy e house-skills.
- [DHH: Promoting AI agents](https://world.hey.com/dhh/promoting-ai-agents-3ee04945) — posição sobre agentes autônomos com supervisão e revisão humana.
- [DHH: Basecamp becomes agent accessible](https://world.hey.com/dhh/basecamp-becomes-agent-accessible-3ae6b949) — estratégia API + CLI + skill, sem exigir um harness específico.

### RedSkills, agentes, macOS e assets RedDB

- [RedSkills atual no commit auditado](https://github.com/reddb-io/red-skills/tree/0cfe62c5185f0b1c82292de880111087b4266e11) — hosts e instalador v3.
- [RedSkills README](https://github.com/reddb-io/red-skills/blob/0cfe62c5185f0b1c82292de880111087b4266e11/README.md) — Claude, Codex, Gemini, OpenCode e Pi.
- [Pi Coding Agent](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md) e [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) — instalação e extensibilidade oficiais.
- [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md) e [Hermes MCP](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md) — diretórios externos e servidores MCP.
- [Homebrew formula API](https://formulae.brew.sh/api/formula.json) e [cask API](https://formulae.brew.sh/api/cask.json) — disponibilidade oficial do catálogo macOS.
- Releases: [toon/tq v0.13.0](https://github.com/reddb-io/toon/releases/tag/v0.13.0), [RedDB v1.23.2](https://github.com/reddb-io/reddb/releases/tag/v1.23.2), [red-request v0.65.1](https://github.com/reddb-io/red-request/releases/tag/v0.65.1), [dit v0.3.2](https://github.com/reddb-io/dit/releases/tag/v0.3.2), [red-ui v0.3.2](https://github.com/reddb-io/red-ui/releases/tag/v0.3.2), [RedSkills v3.3.18](https://github.com/reddb-io/red-skills/releases/tag/v3.3.18).

## Hotlinks

- [Manifesto local](../../src/manifest.ts)
- [Temas locais](../../src/themes.ts)
- [Aplicação de temas local](../../src/theme-apply.ts)
- [Integrações editor/GNOME locais](../../src/theme-editors.ts)
- [Hotkeys locais](../../src/hotkeys.ts)
- [Zellij local](../../config/zellij/config.kdl)
- [Agentes locais](../../src/agents.ts)
- [Runtimes locais](../../src/runtimes.ts)
- [Web apps locais](../../src/webapps.ts)
- [Preferências locais](../../src/preferences.ts)
- [Release workflow local](../../.github/workflows/release.yml)

## Methodology and evidence model

Esta auditoria não inferiu o produto apenas pelo README.

1. O array `TOOLS` foi importado e serializado; foram encontrados 56 itens: 35 `core`, 7 `desktop`, 4 `wsl` e 10 `optional`.
2. `AGENTS`, `OFFERED_RUNTIMES`, `THEMES`, `VSCODE_THEMES`, `WEB_APPS` e `NERD_FONTS` foram lidos diretamente do código.
3. Todos os scripts de instalação do Omakub foram enumerados e agrupados por execução automática, escolha inicial e menu posterior.
4. Os dez diretórios de tema do Omakub foram inspecionados arquivo por arquivo.
5. Hotkeys foram derivadas do `gsettings`, Alacritty, Zellij, Readline e manual oficial.
6. Assets de release RedDB foram consultados na API oficial do GitHub.
7. Disponibilidade macOS foi consultada nas APIs oficiais Homebrew formula/cask.
8. Funções sem call site foram classificadas como implementação desconectada, não como entrega de produto.
9. `house-skills`, `basecamp-cli` e a skill publicada do Basecamp foram clonados, enumerados e lidos no commit atual; a análise separa método de desenvolvimento, distribuição de skills e acesso operacional ao produto.

Legenda usada nas matrizes:

- **default**: ocorre no caminho feliz sem o usuário adicionar o item;
- **preselected**: aparece marcado, mas pode ser desmarcado;
- **optional**: requer escolha deliberada;
- **configured**: não apenas instalado; recebe integração ou baseline;
- **present-only**: o produto detecta ou tematiza se já existir, mas não instala;
- **dead path**: há código, mas não existe comando/menu/call site que o alcance.

## Key Findings

Os achados centrais desta auditoria são:

1. Omakub continua muito à frente como workstation pronta: apps, GNOME, tiling, hotkeys, fontes e assets são uma experiência integrada, não apenas uma lista de pacotes.
2. red-dev possui uma engine de convergência mais geral e um catálogo CLI maior, mas há promessas quebradas em temas, fontes, preferências, web apps, providers e assets de release.
3. Os dez temas existem nominalmente nos dois produtos, porém sete temas red-dev têm integração Neovim incorreta; Rose Pine mistura paleta clara com política dark forçada.
4. O inventário real do red-dev contém 56 itens, mas dependências implícitas ausentes (`wl-clipboard`, browser, FFmpeg, VS Code) impedem partes do produto de funcionar como descritas.
5. A integração de agentes está à frente do Omakub em amplitude, mas red-dev chama RedSkills v2, não oferece Pi e não verifica Gemini/Pi/Hermes de ponta a ponta.
6. A iniciativa 37signals adiciona um benchmark diferente: não só instalar agentes, mas tornar produtos e workflows agent-accessible por CLIs estruturados, skills portáveis, evals e trust boundaries.
7. Para resolver a fragilidade de MCPs, a lição mais útil da 37signals é CLI-first com MCP opcional: JSON, introspecção, non-interactive mode, `doctor` e fallback explícito devem existir antes de o MCP ser considerado parte do caminho crítico.

## Product scorecard

| Dimensão | Omakub | red-dev | Resultado atual |
|---|---|---|---|
| Escopo de OS | Ubuntu 24.04+ GNOME, x86 | Ubuntu, WSL e Windows x64; Darwin apenas detectado | red-dev em ambição; Omakub em honestidade do suporte |
| Distribuição | clone Git completo | binários compilados Linux/Windows, stable/next | red-dev |
| Instalação | scripts lineares, aborta no primeiro erro | convergência por item, falha isolada | red-dev |
| Self-update | `git pull` + migrations | ausente | Omakub |
| Preview e diagnóstico | nenhum equivalente estrutural | `plan`, `doctor`, drift checks | red-dev |
| Desktop Linux | GNOME inteiro configurado | tema/accent/wallpaper, poucos apps | Omakub |
| Windows/WSL | fora de escopo | integração real e configuração compartilhada | red-dev |
| macOS | fora de escopo | fora de escopo, com fallback perigoso para apt | nenhum; red-dev tem obrigação pela própria promessa |
| Programas CLI | bom baseline Ubuntu | baseline maior e multiplataforma | red-dev |
| Programas desktop | workstation amplo | essencialmente RedDB + terminal | Omakub |
| Editor | VS Code baseline + LazyVim pronto | Neovim/VS Code são present-only | Omakub |
| Temas | 10 bundles completos, 8 superfícies | 10 paletas, mais superfícies CLI, bugs de integração | empate conceitual; Omakub mais correto hoje |
| Fontes | instala e sincroniza GNOME/Alacritty/VS Code | instala somente no host Windows via WSL | Omakub |
| Hotkeys | sistema, apps, workspaces, tiling, terminal, emojis | 2 globais Windows + terminal/Zellij | Omakub |
| Tiling | janelas via Tactile + terminal via Zellij | terminal via Zellij; PowerToys sem config | Omakub |
| Linguagens | 8 escolhas; Ruby/Node preselected | 8 escolhas; Node preselected | equivalente, catálogos diferentes |
| Bancos | MySQL/Redis preselected, Postgres opcional | nenhum | Omakub |
| Agentes | não é o foco | 10 entradas, 3 preselected | red-dev |
| Método agentic | house-skills/basecamp-cli ficam fora do Omakub, mas pertencem ao mesmo ecossistema 37signals | RedSkills é mais amplo; falta contrato CLI-first e fallback uniforme para MCP | vantagem distribuída; padrões complementares |
| Ferramentas RedDB | não se aplica | `red`, `tq`, red-request, dit, red-ui, RedSkills | red-dev |
| Ownership de config | frequentemente substitui arquivos | tenta preservar/mesclar e mantém backups | red-dev |
| Validação real | produto maduro em Ubuntu, pouca automação | muitos testes unitários, pouca E2E por OS real | lacuna nos dois, mais crítica no red-dev |

## Complete red-dev installation inventory

Fonte: [`src/manifest.ts`](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/manifest.ts).

### Core — 35 items

| Item | Ubuntu/WSL provider ou asset | Windows provider ou asset | Observação |
|---|---|---|---|
| git | `apt:git` | `winget:Git.Git` | default |
| curl | `apt:curl` | `winget:cURL.cURL` | default |
| unzip | `apt:unzip` | skip, expansão nativa | default onde necessário |
| ripgrep | `apt:ripgrep` | `winget:BurntSushi.ripgrep.MSVC` | comando `rg` |
| fd | `apt:fd-find` | `winget:sharkdp.fd` | normaliza `fdfind`/`fd` |
| bat | `apt:bat` | `winget:sharkdp.bat` | normaliza `batcat`/`bat` |
| eza | `apt:eza` | `winget:eza-community.eza` | aliases `ls`, `lt` |
| zoxide | `apt:zoxide` | `winget:ajeetdsouza.zoxide` | ativado no shell |
| fzf | `apt:fzf` | `winget:junegunn.fzf` | keybindings ativados |
| btop | `apt:btop` | `winget:aristocratos.btop4win` | tema só aplicado no ramo não Windows |
| jq | `apt:jq` | `winget:jqlang.jq` | default |
| tq | `reddb-io/toon:tq-linux-x86_64` | `tq-windows-x86_64.exe` | RedDB, bare binary |
| red | `reddb-io/reddb:red-linux-x86_64` | `red-windows-x86_64.exe` | valida assinatura para não confundir com GNU ed |
| starship | release `starship-x86_64-unknown-linux-gnu.tar.gz` | `winget:Starship.Starship` | prompt principal |
| atuin | release `atuin-x86_64-unknown-linux-musl.tar.gz` | `winget:Atuinsh.Atuin` | histórico/Ctrl-R |
| carapace | release `carapace-bin_*_linux_amd64.deb` | `winget:rsteube.Carapace` | completions |
| direnv | `apt:direnv` | `winget:direnv.direnv` | hook ativado |
| delta | `apt:git-delta` | `winget:dandavison.delta` | configurado como pager Git |
| yazi | release `yazi-x86_64-unknown-linux-gnu.zip` | `winget:sxyazi.yazi` | função shell `y` integrada |
| tldr | release `tealdeer-linux-x86_64-musl` | `winget:dbrgn.tealdeer` | cache inicial baixado |
| fastfetch | PPA `zhangsongcui3371/fastfetch` | `winget:Fastfetch-cli.Fastfetch` | PPA ainda não validado em Ubuntu 26 |
| gh | repositório apt oficial | `winget:GitHub.cli` | default |
| lazygit | release `lazygit_*_Linux_x86_64.tar.gz` | `winget:JesseDuffield.lazygit` | default |
| lazydocker | release `lazydocker_*_Linux_x86_64.tar.gz` | `winget:JesseDuffield.Lazydocker` | default |
| zellij | release `zellij-x86_64-unknown-linux-musl.tar.gz` | `winget:Zellij.Zellij` | sessão automática e tiling de terminal |
| mise | repositório apt oficial | `winget:jdx.mise` | owner dos runtimes |
| neovim | PPA `neovim-ppa/unstable` | `winget:Neovim.Neovim` | binário apenas; sem starter config |
| docker | repo apt + CE/CLI/containerd/buildx/compose | `winget:Docker.DockerDesktop` | adiciona grupo no Linux |
| dotfiles | builtin | builtin | 9 arquivos Bash + config Zellij |
| alacritty-config | builtin | builtin | theme/font/shell/keys e arquivo principal |
| runtimes | builtin | builtin | Node LTS default |
| blesh | builtin | builtin | instalado, desabilitado por default |
| shared-root | builtin | builtin | config WSL/Windows compartilhável |
| hotkeys | builtin, skip fora de Windows/WSL | builtin | dois atalhos globais Windows |
| red-skills | builtin, instalador RedSkills v2 | builtin | só roda se encontrar host suportado conhecido |

### Desktop — 7 items

| Item | Ubuntu desktop | Windows desktop | Observação |
|---|---|---|---|
| gnome-tweaks | `apt:gnome-tweaks` | skip | único utilitário GNOME instalado |
| alacritty | `apt:alacritty` | `winget:Alacritty.Alacritty` | terminal padrão conceitual |
| flatpak | `apt:flatpak` | skip | não adiciona Flathub nem plugin GNOME Software |
| red-request | installer oficial `--no-color` | asset `red-request-windows-x86_64-setup.exe /S` | configurado pelo vendor |
| red-ui | asset `red-ui_*_amd64.deb` | **skip stale: “não há Windows build”** | release atual já possui EXE/MSI Windows |
| dit | installer oficial `--yes --no-service` | asset `dit-windows-x86_64.exe` | serviço Linux deliberadamente desativado |
| wsl-sync | skip em Linux | builtin em Windows | instala/sincroniza red-dev dentro da distro |

### WSL — 4 items

| Item | Provider | Entrega |
|---|---|---|
| wsl-interop | builtin | preserva execução de `.exe` quando systemd-binfmt limpa o registro |
| nerd-font | builtin | instala a fonte no host Windows, onde o terminal renderiza |
| alacritty-host | winget através do host | instala Alacritty Windows a partir do WSL |
| windows-terminal | builtin | escreve perfil, esquema, fonte e shell no Windows Terminal |

### Optional — 10 items

No primeiro run, todos os disponíveis são preselected, exceto os marcados “off”.

| Item | Ubuntu | Windows | Default da seleção |
|---|---|---|---|
| PowerToys | skip | `winget:Microsoft.PowerToys` | preselected no Windows |
| Blender | builtin release oficial | `winget:BlenderFoundation.Blender` | off, aproximadamente 1.2 GB |
| RedSkills VS Code | build/install builtin | build/install builtin | off |
| RedSkills Herdr | build/install builtin | skip | off |
| just | `apt:just` | `winget:Casey.Just` | preselected |
| duf | `apt:duf` | `winget:muesli.duf` | preselected |
| dust | release `dust-*-x86_64-unknown-linux-musl.tar.gz` | `winget:bootandy.dust` | preselected |
| hyperfine | `apt:hyperfine` | `winget:sharkdp.hyperfine` | preselected |
| glow | release `glow_*_Linux_x86_64.tar.gz` | `winget:charmbracelet.glow` | preselected |
| gitui | release `gitui-linux-x86_64.tar.gz` | `winget:StephanDilly.gitui` | preselected |

### Agents — 10 catalog entries

Fonte: [`src/agents.ts`](https://github.com/reddb-io/red-dev/blob/e7757978783fc96ec8871e5efdeddc93ee8adc06/src/agents.ts).

| Agent | Linux/WSL | Windows | First run | RedSkills verificado pelo red-dev |
|---|---|---|---|---|
| Claude Code | `https://claude.ai/install.sh` | `Anthropic.ClaudeCode` | preselected | sim |
| Codex CLI | npm `@openai/codex` | `OpenAI.Codex` | preselected | sim |
| OpenCode | installer oficial | `SST.opencode` | preselected | sim |
| Gemini CLI | npm `@google/gemini-cli` | npm | optional | não; v3 suporta, red-dev chama v2 |
| T3 Code | desktop-only | `T3Tools.T3Code` | optional Windows | não aplicável |
| Herdr | `https://herdr.dev/install.sh` | indisponível | optional | plugin RedSkills separado, optional/off |
| OpenClaw | installer oficial | npm `openclaw` | optional | não |
| Hermes Agent | installer oficial | npm `hermes-agent` | optional | não |
| Claude Desktop | indisponível neste catálogo Linux | `Anthropic.Claude` | optional Windows | não aplicável |
| Codex Desktop | indisponível neste catálogo Linux | Microsoft Store `9PLM9XGG6VKS` | optional Windows | não aplicável |

**Ausência crítica:** Pi não está no catálogo, embora o instalador RedSkills v2 chamado pelo próprio red-dev já saiba instalar packages no Pi quando o comando `pi` existe.

### Runtimes — 8 choices

| Runtime | Versão escolhida pelo red-dev | Default |
|---|---|---|
| Node.js | `node@lts` | sim |
| Bun | `bun@latest` | não |
| Deno | `deno@latest` | não |
| Python | `python@3.13` | não |
| Go | `go@latest` | não |
| Rust | `rust@stable` | não |
| Ruby | `ruby@3.4` | não |
| Java | `java@lts` | não |

Todos são geridos por mise, exceto Rust, cuja semântica interna do mise pode usar rustup. Node habilita corepack quando possível.

### Web apps — 6 entries, currently a dead path

| Web app | URL | O que existe |
|---|---|---|
| ChatGPT | `chatgpt.com` | `.desktop` Linux + icon CDN |
| Claude | `claude.ai` | `.desktop` Linux + icon CDN |
| Google Photos | `photos.google.com` | `.desktop` Linux + icon CDN |
| Google Contacts | `contacts.google.com` | `.desktop` Linux + icon CDN |
| Tailscale | admin web | `.desktop` Linux + icon CDN |
| GitHub | `github.com` | `.desktop` Linux + icon CDN |

O módulo exige Chrome/Chromium/Brave/Edge, mas o red-dev não instala nenhum browser. Também não há referência a `WEB_APPS` fora de `src/webapps.ts`; portanto, nenhuma entrada de CLI ou TUI permite chegar a essa funcionalidade. Windows e macOS não têm adapters.

## Complete Omakub installation inventory

Fonte: árvore oficial [`install/`](https://github.com/basecamp/omakub/tree/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install).

### Bootstrap and terminal base

O caminho padrão faz `apt update`, `apt upgrade`, instala `curl`, `git`, `unzip` e depois executa todos os scripts em `install/terminal/*.sh`.

#### Development libraries and clients

| Grupo | Pacotes default |
|---|---|
| Build | build-essential, pkg-config, autoconf, bison, clang, rustc, pipx |
| Runtime headers | libssl-dev, libreadline-dev, zlib1g-dev, libyaml-dev, libncurses5-dev, libffi-dev, libgdbm-dev, libjemalloc2 |
| Images/PDF | libvips, imagemagick, libmagickwand-dev, mupdf, mupdf-tools |
| Data clients | redis-tools, sqlite3, libsqlite3-0, libmysqlclient-dev, libpq-dev, postgresql-client, postgresql-client-common |

#### Default terminal tools

| Tool | Provider/asset | Configuration |
|---|---|---|
| fzf | apt | Bash completion/keybindings |
| ripgrep | apt | none |
| bat | apt | alias `batcat` → `bat` |
| eza | apt | aliases `ls`, `lt` |
| zoxide | apt | `cd` aliased to `z` |
| plocate | apt | none |
| apache2-utils | apt | none |
| fd-find | apt | alias `fd` |
| btop | apt | config + Tokyo Night theme |
| fastfetch | PPA | config if absent |
| GitHub CLI | repo apt oficial | none |
| LazyDocker | latest GitHub tarball | `/usr/local/bin` |
| LazyGit | latest GitHub tarball | config directory |
| Neovim | stable x86_64 tarball | LazyVim starter completo quando ausente |
| luarocks | apt | suporte LazyVim |
| tree-sitter-cli | apt | suporte LazyVim |
| Zellij | latest GitHub tarball | config + Tokyo Night |
| Docker Engine | repo oficial | daemon config, group, buildx, compose, rootless extras |
| mise | repo apt oficial | runtime owner |
| gum 0.17.0 | GitHub `.deb` pinado | UI do Omakub |

### Default desktop applications

Executados automaticamente quando `XDG_CURRENT_DESKTOP` contém GNOME.

| App/capability | Provider | Configuration adicional |
|---|---|---|
| Flatpak | apt | Flathub + GNOME Software plugin |
| Alacritty | apt | config completa, theme/font/size, default terminal |
| Google Chrome | `.deb` oficial | default browser |
| Flameshot | apt | Ctrl+Print global |
| GNOME Sushi | apt | Space preview no Files |
| GNOME Tweaks | apt | instalado |
| LibreOffice | apt | app grid folder |
| LocalSend | GitHub `.deb` | dock quando presente |
| Obsidian | GitHub `.deb` | dock quando presente |
| Pinta | Flatpak | dock quando presente |
| Signal | repo apt oficial | dock quando presente |
| Typora | repo apt oficial | temas iA Writer claro/escuro |
| VLC | apt | instalado |
| VS Code | repo apt Microsoft | baseline settings + Tokyo Night extension |
| wl-clipboard | apt | clipboard Neovim/Wayland |
| Xournal++ | apt | PDFs/anotações |
| Ulauncher | PPA | autostart, tema dark, Super+Space |
| Fonts | Nerd Fonts + iA Writer Mono | fontconfig e integração GNOME |

### First-run preselected options

| Categoria | Preselected | Available but off |
|---|---|---|
| Apps | 1Password, Spotify, Zoom | Dropbox |
| Languages | Ruby on Rails, Node.js | Go, PHP, Python, Elixir, Rust, Java |
| Databases | MySQL 8.4, Redis 7 | PostgreSQL 16 |

Os bancos são containers Docker com restart `unless-stopped`, binds somente em `127.0.0.1` e autenticação local simplificada para desenvolvimento.

### Optional apps from the Omakub menu

| Categoria | Apps/capabilities |
|---|---|
| Segurança/sync | 1Password + CLI, Dropbox, Tailscale |
| Browser/comunicação | Brave, Discord, Zoom |
| Áudio/vídeo | Audacity, OBS Studio, Spotify |
| Imagem | Gimp |
| Desenvolvimento/hardware | ASDControl, Geekbench, Mainline Kernels, Ollama |
| Games/VM | Minecraft, RetroArch, Steam, VirtualBox |
| Editors | Cursor, Doom Emacs, RubyMine, Windsurf, Zed |
| Web apps | ChatGPT, Google Photos, Google Contacts, Tailscale |

Há ainda um helper de Windows 11/virtio acessível pelo seletor de arquivos de installers, mas não aparece como entrada principal do menu.

### Default desktop launchers and web apps

Omakub cria oito `.desktop` próprios durante a instalação:

| Launcher | Destino |
|---|---|
| About | Fastfetch dentro de Alacritty |
| Activity | btop dentro de Alacritty |
| Docker | LazyDocker dentro de Alacritty |
| Neovim | nvim dentro de Alacritty |
| Omakub | painel Omakub dentro de Alacritty |
| Basecamp | Chrome app para 37signals Launchpad |
| HEY | Chrome app para HEY |
| WhatsApp | Chrome app para WhatsApp Web |

Os quatro web apps opcionais usam o mesmo padrão `google-chrome --app`, baixam ícones e entram na pasta GNOME “Web Apps”.

## Program-by-program gap analysis

### Shared baseline

Ambos instalam Git, curl, unzip, ripgrep, fd, bat, eza, zoxide, fzf, btop, fastfetch, GitHub CLI, LazyGit, LazyDocker, Zellij, mise, Neovim e Docker.

### red-dev-only strengths

| Capability | red-dev | Valor |
|---|---|---|
| Structured data | jq + tq | JSON e TOON como baseline |
| RedDB CLI | `red` | stack interna no core |
| Shell UX | Starship, Atuin, Carapace, direnv | prompt, history, completions, env por diretório |
| Git UX | delta | pager e conflitos `zdiff3` configurados |
| File navigation | yazi | file manager terminal integrado ao cwd |
| Help | tealdeer/tldr | cache inicial preparado |
| Optional CLI | just, duf, dust, hyperfine, glow, gitui | toolbox moderno |
| Cross-platform | winget + WSL bridge | catálogo substancial em Windows |

### Omakub-only strengths

| Capability | Omakub | Gap red-dev |
|---|---|---|
| Toolchain native | compiladores, headers e libs de imagem/PDF/database | projetos podem falhar no build após “setup concluído” |
| Database clients | Redis, SQLite, MySQL e PostgreSQL clients/dev libs | red-dev instala Docker, mas nenhum client/database profile |
| Browser | Chrome default | web apps do red-dev não conseguem funcionar numa máquina realmente limpa |
| Editor baseline | VS Code settings + LazyVim starter | red-dev tematiza apenas se já existir |
| Clipboard Linux | wl-clipboard | red-dev configura Zellij para `wl-copy`, mas não instala o comando |
| Launcher | Ulauncher | nenhum launcher no red-dev |
| Screenshots | Flameshot + hotkey | nenhum fluxo equivalente |
| Workstation | office, notes, media, communication, file transfer | perfil corporativo incompleto |
| GNOME polish | extensions, dock, grid, six workspaces | quase ausente |
| Databases | MySQL, Redis, Postgres Docker | ausente |

### Concrete dependency mismatches in red-dev

1. Zellij recebe `copy_command "wl-copy"` no desktop Linux, mas `wl-clipboard` não está no manifesto.
2. A função `webm2mp4` chama `ffmpeg`, mas `ffmpeg` não é instalado.
3. Web apps exigem browser Chromium-family, mas nenhum é instalado.
4. A extensão RedSkills VS Code pode ser oferecida sem VS Code/Codium/Cursor; o código então apenas pula.
5. A integração de tema VS Code também é present-only.
6. `red-skills-herdr` exige Herdr, mas ambos são optional e off; não existe seleção dependente que marque o plugin ao escolher Herdr.

## Themes — complete inventory

### Bundle shape

Cada tema Omakub contém exatamente oito assets funcionais:

1. `alacritty.toml`
2. `zellij.kdl`
3. `btop.theme`
4. `neovim.lua`
5. `vscode.sh`
6. `gnome.sh`
7. `tophat.sh`
8. `background.jpg` ou `background.png`

O red-dev define cada tema como uma paleta central de 20 cores e um nome Neovim. A partir dela, gera Alacritty, Windows Terminal, Zellij, btop, lazygit, wallpaper e accents. Integrações que não aceitam uma paleta arbitrária usam mappings.

O modelo central do red-dev reduz duplicação e favorece adapters multiplataforma. O bundle explícito do Omakub, porém, força cada tema a provar que todas as superfícies existem. O red-dev hoje permite que uma paleta seja adicionada sem um plugin Neovim, extension VS Code ou wallpaper versionado correspondente.

### Theme-by-theme compatibility

| Tema | Omakub GNOME/mode | Omakub Neovim | Omakub VS Code | red-dev Neovim | red-dev VS Code | red-dev wallpaper |
|---|---|---|---|---|---|---|
| Tokyo Night | purple/dark | `tokyonight` | `enkia.tokyo-night` | plugin correto | correto | committed + runtime |
| Catppuccin | magenta/dark | `catppuccin` | `Catppuccin.catppuccin-vsc` | plugin correto | correto | committed + runtime |
| Gruvbox | sage/dark | `ellisonleao/gruvbox.nvim` / `gruvbox` | `jdinhlife.gruvbox` | plugin correto | correto | committed + runtime |
| Everforest | bark/dark | `neanias/everforest-nvim` | `sainnhe.everforest` | **não instala plugin; fallback declara Tokyo Night** | correto | runtime-only |
| Kanagawa | purple/dark | `rebelot/kanagawa.nvim` | `qufiwefefwoyn.kanagawa` | **não instala plugin** | correto | runtime-only |
| Matte Black | orange/dark | `tahayvr/matteblack.nvim` / `matteblack` | `CleanThemes.matte-black-theme` | **usa `matte-black`, nome divergente, e plugin errado** | correto | runtime-only |
| Nord | blue/dark | `EdenEast/nightfox.nvim` / `nordfox` | `arcticicestudio.nord-visual-studio-code` | **usa `nord` e plugin errado** | correto | runtime-only |
| Osaka Jade | green/dark | `ribru17/bamboo.nvim` / `bamboo` | Ocean Green approximation | **usa `osaka-jade` e plugin errado** | **sem mapping** | runtime-only |
| Ristretto | grey/dark | `gthelding/monokai-pro.nvim` / filter Ristretto | Monokai Pro Ristretto | **usa `ristretto` e plugin errado** | correto | runtime-only |
| Rose Pine | red/**light** | `rose-pine-dawn` | Rosé Pine Dawn | **usa `rose-pine`, plugin errado** | usa Rosé Pine, não Dawn | runtime-only; sistema forçado dark |

“Plugin errado” significa: o arquivo que o red-dev gera declara `folke/tokyonight.nvim` como fallback e pede outro colorscheme. Se o usuário já tiver instalado o plugin necessário por conta própria, pode funcionar; o red-dev não garante isso. Em uma configuração nova, a integração não é autocontida.

### Surface coverage by platform

| Superfície | Omakub Ubuntu | red-dev Ubuntu | red-dev WSL | red-dev Windows |
|---|---|---|---|---|
| Alacritty | 10/10 | 10/10 | host Windows 10/10 | 10/10 |
| Windows Terminal | n/a | n/a | 10/10 | 10/10 |
| Zellij | 10/10 | 10/10 | 10/10 | **não chamado pelo ramo Windows** |
| btop | 10/10 | 10/10 | 10/10 | **não chamado** |
| Neovim | 10/10 autocontido | 3/10 garantidos | 3/10 garantidos | 3/10 garantidos |
| VS Code | 10/10 | 9/10, present-only | 9/10, host-aware | 9/10, present-only |
| GNOME mode/accent | 10/10 + GTK/icon/cursor | 10 aplicados, Rose incorreto | n/a | n/a |
| Windows dark/accent | n/a | n/a | 10 aplicados, Rose incorreto | 10 aplicados, Rose incorreto |
| TopHat | 10/10 | não instala nem tematiza | n/a | n/a |
| Wallpaper | 10 imagens | 10 gerados runtime | 10 gerados no host | 10 gerados |
| bat | não | 10 aproximações | 10 aproximações | **não chamado** |
| delta | não | 10 aproximações | 10 aproximações | **não chamado** |
| lazygit | não | 10 quando config é gerenciável | idem | **não chamado** |
| OpenCode | não | segue `system` | segue `system` | **não chamado** |
| Herdr | não | 4 temas nativos, 6 seguem terminal | idem | indisponível |
| fzf | não | função de cores existe, sem call site | idem | idem |

### Theme semantics and correctness gaps

- Omakub muda GTK theme, icon theme, cursor theme, accent, light/dark, TopHat e wallpaper. red-dev no GNOME muda apenas `color-scheme` e `accent-color`.
- Rose Pine é explicitamente light no Omakub. O background do red-dev é `#FAF4ED`, também claro, mas `applyGnomeTheme()` e `applyWindowsDesktopTheme()` afirmam que todos os temas são dark e forçam dark mode.
- Omakub aproxima Osaka Jade no VS Code com Ocean Green. O red-dev prefere pular; essa honestidade é aceitável, mas a cobertura precisa aparecer na UI como 9/10, não como “tema aplicado everywhere”.
- bat e delta não recebem a paleta exata; recebem o tema embutido mais próximo. A UI deve rotular isso como approximation.
- lazygit recebe cores exatas, mas se o config já existir e não tiver o marker red-dev, é deixado intacto.
- VS Code settings com comentários/trailing commas são válidos para o editor, mas o red-dev usa `JSON.parse` e não aplica nada. Omakub evita isso porque cria seu próprio baseline, embora seu `sed` também dependa da chave já existir.

## Assets — complete comparison

### Distribution assets

#### red-dev v0.17.1

| Asset | Bytes | Papel |
|---|---:|---|
| `red-dev-linux-x64` | 95,537,280 | Linux e WSL x86_64 |
| `red-dev-windows-x64.exe` | 99,427,840 | Windows x86_64 |
| `SHA256SUMS` | 174 | checksums canônicos |
| `checksums.txt` | 174 | compatibilidade de naming |

O release workflow também tenta publicar build provenance attestation. Os bootstraps, contudo, não validam o SHA256 nem a attestation: Linux baixa e move; Windows valida somente o tamanho retornado pela API.

#### Omakub v1.5.0

A release não publica binários ou bundles próprios. `boot.sh` remove `~/.local/share/omakub`, clona o repositório completo e faz checkout da ref stable/master. Os assets viajam no Git checkout.

### Static/configuration assets

#### red-dev repository

- 3 wallpapers PNG committed: Tokyo Night, Catppuccin e Gruvbox, todos 2560×1440;
- 3 SVGs de documentação: hero, stack e themes;
- 9 arquivos Bash embedded: rc, path, init, aliases, functions, prompt, shared, zellij autostart e inputrc;
- 1 config Zellij base com 287 linhas;
- 1 hook Castle MCP;
- configurações Alacritty/Windows Terminal/tema/wallpaper são geradas por código, não arquivos estáticos.

O script `generate-wallpapers.ts` percorre dez temas, mas sete PNGs não estão versionados. Isso contradiz o comentário de `wallpaper.ts` e deixa a revisão visual incompleta. O runtime continua capaz de gerar os dez.

#### Omakub repository

- 80 assets de tema: 10 temas × 8 arquivos;
- 10 wallpapers fotográficos/ilustrados, de 2912×1632 a 6930×3960;
- 9 ícones PNG próprios para launchers;
- configs estáticos de Alacritty, btop, fastfetch, inputrc, LazyVim, Typora, Ulauncher, VS Code, XCompose e Zellij;
- 8 scripts de `.desktop` próprios;
- 16 migrations timestamped no commit auditado.

### Wallpaper strategy

| Aspecto | Omakub | red-dev |
|---|---|---|
| Fonte | imagem curada por tema | gradiente determinístico da paleta |
| Quantidade entregue no repo | 10 | 3 de 10 |
| Dependência de rede ao aplicar | não | não |
| Resolução | variável, majoritariamente alta | fixa 2560×1440 |
| Identidade visual | forte e distinta | coerente, porém mais genérica |
| Licenciamento/proveniência | não documentado por asset | geração própria evita dúvida |
| Windows | não | sim |
| macOS | não | não |

Oportunidade: manter wallpapers gerados como fallback universal, mas permitir assets art-directed por tema com metadata de licença, autor, hash, aspect ratios e crop/focal point.

### Current RedDB release assets by platform

| Produto | Linux x64 | Linux ARM | Windows | macOS Intel | macOS ARM | Gap no manifesto red-dev |
|---|---|---|---|---|---|---|
| tq/toon v0.13.0 | sim | aarch64 | x64 | sim | sim | só Linux/Windows x64 |
| RedDB `red` v1.23.2 | sim | aarch64 + armv7 | x64 | sim | sim | só Linux/Windows x64 |
| red-request v0.65.1 | deb/AppImage | aarch64 | setup x64 | DMG | DMG | sem mac; Linux ARM ausente |
| dit v0.3.2 | sim | aarch64 + armv7 | x64 + ARM | sim | sim | só Linux/Windows x64 |
| red-ui v0.3.2 | deb/AppImage | aarch64 | EXE + MSI | DMG/universal | DMG/universal | Windows incorretamente marcado skip; mac ausente |
| RedSkills v3.3.18 | scripts/assets JS | universal | via Bash/Git Bash | via shell | via shell | red-dev chama v2 e verifica somente 3 hosts |

Isso muda a avaliação de viabilidade: a maior parte da stack RedDB já está pronta para macOS e ARM. O gargalo está no red-dev, não nos produtos dependentes.

## Fonts — complete comparison

| Produto | Família | Asset Nerd Fonts | Default |
|---|---|---|---|
| Omakub | Caskaydia Mono | CascadiaMono.zip | sim |
| Omakub | Fira Mono | FiraMono.zip | não |
| Omakub | JetBrains Mono | JetBrainsMono.zip | não |
| Omakub | Meslo | Meslo.zip | não |
| red-dev | FiraCode | FiraCode.zip | sim |
| red-dev | JetBrains Mono | JetBrainsMono.zip | não |
| red-dev | Hack | Hack.zip | não |
| red-dev | Caskaydia Cove | CascadiaCode.zip | não |

Ambos oferecem tamanho 7–14. Omakub começa em 9; o red-dev gera 11 quando nenhum tamanho é passado.

### Omakub font behavior

- instala arquivos em `~/.local/share/fonts` e executa `fc-cache`;
- configura monospace do GNOME;
- troca `font.toml` do Alacritty;
- troca `editor.fontFamily` do VS Code;
- tamanho afeta Alacritty e apps dentro do terminal, não VS Code.

### red-dev font behavior and defects

- a implementação real de instalação chama o font store Windows e só é executada no scope WSL;
- Ubuntu desktop recebe Alacritty apontando para uma família que o red-dev não instalou;
- Windows nativo não executa o scope WSL e também pode receber uma família ausente;
- o `doctor` verifica fonte apenas em Windows/WSL e responde `n/a` no Ubuntu;
- o menu salva `font` e `fontSize`, porém `ApplyContext` contém somente os defaults da invocação;
- `configureAlacritty()` usa tamanho 11 quando `fontSize` não é passado;
- mudar o tema ou rodar converge/update pode sobrescrever `font.toml` com FiraCode tamanho 11, mesmo que preferences registrem outra escolha.

P0: transformar fonte em recurso por plataforma com `install`, `apply`, `verify` e `current`, e fazer todo comando ler a preferência persistida antes de montar o plano.

## Hotkeys — complete comparison

### Omakub system/navigation hotkeys

Fonte: [código GNOME](https://github.com/basecamp/omakub/blob/c873902f1a5d8b0f54e2e52d565a77274a5941ff/install/desktop/set-gnome-hotkeys.sh) e [manual](https://learn.omacom.io/1/read/29/hotkeys).

| Hotkey | Ação |
|---|---|
| Super+Space | Ulauncher |
| Super+A | app grid GNOME |
| Super+W | fechar janela |
| Super+Up | maximizar |
| Super+Backspace | iniciar resize |
| Shift+F11 | fullscreen com chrome/título |
| Super+1…6 | ir ao workspace 1…6 |
| Shift+Super+1…4 | mover janela ao workspace; documentado no manual, mas não redefinido explicitamente pelo script auditado |
| Alt+1…9 | abrir/focar app fixado no dock |
| Shift+Alt+1 | nova janela Chrome |
| Shift+Alt+2 | nova janela Alacritty |
| Ctrl+Print | captura de região Flameshot |
| Shift+AudioPlay | próxima faixa |
| Ctrl+F1 | brilho Apple display para baixo |
| Ctrl+F2 | brilho para cima |
| Ctrl+Shift+F2 | brilho máximo |

O manual ainda mostra Super+1…4, mas o código atual configura seis workspaces. Esta é uma divergência de documentação.

### Omakub window tiling hotkeys

| Hotkey | Ação |
|---|---|
| Super+Left | metade esquerda GNOME |
| Super+Right | metade direita GNOME |
| Super+Up | maximizar |
| Super+T | overlay Tactile |
| Super+Shift+T | settings Tactile |
| Super+T, W, S | centro vertical |
| Super+T, Q, A | coluna esquerda |
| Super+T, E, D | coluna direita |
| Super+T, Q, Q | superior esquerda |
| Super+T, A, A | inferior esquerda |

O Tactile é configurado como quatro colunas com pesos `1,2,1,0`, duas linhas `1,1` e gap 32. O modelo visual efetivo possui seis regiões úteis.

### red-dev global hotkeys

| Plataforma | Hotkey | Ação |
|---|---|---|
| Windows/WSL host | Ctrl+Alt+T | Alacritty quando disponível; fallback WSL |
| Windows/WSL host | Ctrl+Alt+Shift+T | PowerShell elevado, com UAC |
| Ubuntu | — | nenhum hotkey global configurado |
| macOS | — | nenhum suporte |

Os atalhos Windows são `.lnk` no Start Menu e não exigem AutoHotkey/PowerToys. É uma implementação elegante e pequena, mas cobre apenas abertura de terminal/admin.

### Alacritty hotkeys

| Ação | Omakub | red-dev |
|---|---|---|
| Fullscreen | F11 | F11 |
| Paste Windows muscle memory | defaults do Alacritty | Ctrl+V e Ctrl+Shift+V |
| Copy | defaults | Ctrl+Shift+C |
| New terminal instance | GNOME Shift+Alt+2 | Ctrl+Shift+N dentro do terminal |
| Increase font | não customizado | Ctrl+= |
| Decrease font | não customizado | Ctrl+- |
| Reset font | não customizado | Ctrl+0 |

### Zellij terminal tiling

Os dois projetos compartilham essencialmente a mesma tabela de bindings, em locked mode:

| Hotkey/mode | Ação |
|---|---|
| Ctrl+G | desbloquear e entrar no modo normal |
| Alt+Arrow ou Alt+H/J/K/L | navegar panes/tabs sem sair de locked |
| Alt+N | novo pane |
| Alt+= / Alt+- | aumentar/diminuir pane |
| Alt+[ / Alt+] | trocar swap layout |
| Alt+F | toggle floating panes |
| Ctrl+G, P, R | novo pane à direita |
| Ctrl+G, P, D | novo pane abaixo |
| Ctrl+G, P, X | fechar pane |
| Ctrl+G, P, F | fullscreen do pane |
| Ctrl+G, T, N | nova tab |
| Ctrl+G, T, R | renomear tab |
| Ctrl+G, T, 1…9 | ir à tab |
| Ctrl+G, O, D | detach |
| Ctrl+G, O, W | session manager |
| Ctrl+G, S, E | editar scrollback |
| Ctrl+G, R, H/J/K/L | resize direcional |
| Ctrl+Q em modo desbloqueado | sair do Zellij |

O red-dev melhora a base com:

- Zellij automático em qualquer shell interativo compatível, não só Alacritty;
- exclusões para VS Code, JetBrains, Neovim, Emacs e tmux;
- fallback para Bash se Zellij falhar;
- session serialization e pane viewport serialization;
- scrollback 50.000;
- clipboard `clip.exe` em WSL/Windows e `wl-copy` no desktop Linux;
- configuração compartilhável WSL/Windows.

O problema é de framing: Zellij resolve tiling **dentro do terminal**. Ele não substitui tiling de janelas de browser, editor, Red Request e desktop apps. O comentário do manifesto usa Zellij como resposta multiplataforma ao Tactile/FancyZones, mas são camadas diferentes.

### Readline, history and text input

Ambos configuram Up/Down como prefix history search, completion case-insensitive, completions visíveis e comportamento melhor de symlinks/hidden files.

- Omakub entrega Ctrl+R via fzf e um XCompose extenso, incluindo atalhos CapsLock para emojis.
- red-dev entrega Ctrl+R via Atuin, Carapace completions, autocd/cdspell/globstar/direnv e não possui XCompose/emoji layer.

### Hotkey product gap

O red-dev precisa de um catálogo semântico, não de três arquivos independentes:

```ts
type ActionId =
  | "launcher.open"
  | "terminal.new"
  | "terminal.admin"
  | "window.close"
  | "window.maximize"
  | "window.tile.left"
  | "window.tile.right"
  | "window.tile.grid"
  | "workspace.goto.1"
  | "workspace.move.1"
  | "app.focus.1"
  | "screenshot.region";
```

Cada adapter GNOME, Windows e macOS deve declarar binding, dependency, conflict detection, apply e verify. A cheat sheet deve ser gerada desse mesmo schema.

## Tiling and desktop coherence

### Omakub model

1. GNOME native split/maximize para laptop.
2. Tactile para grids maiores.
3. Seis workspaces fixos para isolamento de tarefas.
4. Dock numerado via Alt+1…9.
5. Zellij para panes/tabs/session dentro do terminal.
6. Ulauncher para abrir qualquer aplicação sem navegação visual.

### red-dev model today

1. Zellij é o único tiling realmente configurado.
2. PowerToys é preselected no Windows, mas FancyZones não recebe layout/config/hotkeys.
3. Windows Snap Layouts ficam nos defaults do OS.
4. GNOME não recebe Tactile, workspaces, dock ou launcher.
5. macOS não tem adapter.

### Recommended coherent model

- **Terminal tiling:** Zellij em todas as plataformas.
- **Window tiling:** Tactile ou equivalente GNOME; FancyZones/Snap no Windows; uma escolha oficial via ADR no macOS.
- **Workspace semantics:** 1–6 com ações equivalentes, mesmo que o mecanismo varie.
- **Launcher semantics:** Super/Win/Cmd+Space ou uma combinação sem conflito, adaptada por plataforma.
- **Layout presets:** laptop 2-column, ultrawide 3-column, focus, presentation.
- **Generated docs:** um único mapa visual de hotkeys por plataforma.

## GNOME and desktop assets

### Omakub GNOME extensions

| Extension | Papel | Configuração principal |
|---|---|---|
| Tactile | tiling grid | 3 colunas úteis × 2 linhas, gap 32 |
| Just Perfection | shell polish | animação, workspace, popup |
| Blur My Shell | visual | blur no overview/dock |
| Space Bar | workspaces | nomes e shortcuts |
| Undecorate | remover title bars | menu de janela |
| TopHat | métricas | cores por tema, network bits |
| Alphabetical App Grid | organização | folders ao final |

Omakub desabilita Tiling Assistant, AppIndicators, Ubuntu Dock e Desktop Icons NG antes de instalar sua camada.

### red-dev GNOME behavior

- instala `gnome-tweaks` e Flatpak;
- ajusta light/dark e accent no theme switch;
- aplica wallpaper;
- não instala extensions, launcher, clipboard package, screenshots, dock, app grid ou workspace policy;
- não registra hotkeys GNOME;
- README admite ausência e falta de validação em hardware real.

### Windows behavior

red-dev é mais avançado que o Omakub por definição:

- dark mode de apps e sistema;
- accent DWM e prevalence;
- wallpaper com refresh imediato via `SystemParametersInfo`;
- Windows Terminal theme/font/profile;
- Alacritty com Git Bash ou WSL escolhido;
- PowerToys disponível;
- shared config e distro sync.

Mas a experiência ainda não é um desktop opinionado: não há FancyZones config, launcher/remapper config, dock/taskbar policy, workspace mapping ou equivalentes dos atalhos GNOME.

## Shell, aliases and functions

### Shared Omakub lineage

Ambos fornecem aliases `ls/lsa/lt/lta`, navegação `../...`, `n`, `g`, `d`, `lzg`, `lzd`, `ff`, `compress/decompress` e funções `webm2mp4`, `iso2sd`, `web2app`.

### red-dev additions

- Git aliases completos: status, diff, staging, commits, switch, branches, push seguro, pull rebase, fetch prune, logs, stash, rebase e worktrees;
- `gdm` para diff desde merge-base;
- `mkcd`, `fe`, `fcd` e wrapper `y`;
- `winopen` e `winpath` equivalentes em WSL/Git Bash;
- PATH preservado/deduplicado, sem apagar interop WSL;
- Starship, Atuin, Carapace, direnv e mise ativados;
- config sharing para Starship, mise, Zellij, yazi, Atuin, bat e Git include.

### Ownership difference

Omakub move `~/.bashrc` para backup e o substitui integralmente. red-dev faz backup, adiciona uma linha de source e mantém seus próprios arquivos versionados em `~/.local/share/red-dev`. A política do red-dev é mais segura para uma ferramenta corporativa que será atualizada repetidamente.

## Agents and RedSkills readiness

### Current RedSkills host support

| Host | RedSkills v2 called by red-dev | RedSkills v3 current | red-dev installs host | red-dev doctor verifies |
|---|---|---|---|---|
| Claude Code | sim | sim | sim | sim, source GitHub |
| Codex | sim | sim | sim | sim, marketplace wiring |
| OpenCode | sim | sim | sim | sim, manifest file |
| Pi | sim | sim | **não** | não |
| Gemini | não | sim | sim | não |
| Hermes | não | não | sim | não |

O primeiro relatório subestimou Pi: o instalador RedSkills v2 já suporta Pi packages. O gap está em `AGENTS` e em `SKILL_HOSTS`, não na inexistência de integração upstream.

### What “ready” must mean

Um host não está pronto apenas porque o executável responde:

1. executável instalado;
2. versão registrada;
3. RedSkills wired no scope correto;
4. skills `dev`, `memory`, `brain` visíveis;
5. MCPs inicializam;
6. hooks/plugins/statusline instalados quando suportados;
7. source aponta para GitHub/canal atualizável, não snapshot congelado;
8. smoke command por host passa;
9. autenticação pendente é apresentada como HITL explícito.

### Hermes path

Hermes permite `skills.external_dirs` e MCPs em configuração. Um adapter inicial pode apontar para um diretório de skills compartilhadas. Isso não equivale automaticamente às superfícies completas de Claude/Codex/OpenCode; o caminho correto é adicionar suporte oficial no repositório RedSkills e consumir esse host adapter no red-dev.

### Agent roadmap

1. adicionar Pi ao `AGENTS` com installer oficial;
2. mover red-dev para RedSkills v3;
3. adicionar Pi e Gemini ao `SKILL_HOSTS`/doctor;
4. criar contrato `SkillHostAdapter` com install/wire/verify/update/uninstall;
5. implementar Hermes upstream em RedSkills;
6. fazer a seleção de Herdr marcar/oferecer automaticamente o plugin RedSkills Herdr;
7. garantir uma única versão RedSkills por máquina e reportar skew.

## DHH/37signals agent initiative — deep comparison

### Which repository the request refers to

Há duas iniciativas oficiais próximas, mas com papéis diferentes:

| Repositório | Papel | Unidade distribuída |
|---|---|---|
| [`basecamp/house-skills`](https://github.com/basecamp/house-skills) | método opinionado de trabalho com agentes | 11 skills em quatro plugins |
| [`basecamp/basecamp-cli`](https://github.com/basecamp/basecamp-cli) + [`basecamp/skills`](https://github.com/basecamp/skills) | tornar o produto Basecamp operável por agentes | CLI versionado + skill publicada automaticamente |

O primeiro é o repositório “super opinionated” sobre como configurar e conduzir agentes. O segundo é a materialização da tese pública do DHH: API abrangente, CLI amigável a máquina e skill que ensina qualquer harness a operar o produto.

Commits auditados em 3 de agosto de 2026:

- `house-skills`: `d2d85abe034b0e6d4bfc3dbef646c427b05a385f`;
- `basecamp-cli`: `3e86a0f0f50772eddbe0a607a5fc5c9c3809d7cf`, release `v0.8.0`;
- `basecamp/skills`: `024f56a8e058c9fecdeea6aef9eb5e02c6f10022`, sincronizado do `basecamp-cli v0.8.0`.

### The 37signals stack is three layers, not one

```text
human intent
  -> harness (Claude Code, Codex, OpenCode, Gemini, etc.)
  -> house method (AGENTS.md + house-skills + hooks/evals)
  -> product skill (Basecamp/HEY/Fizzy workflow knowledge)
  -> structured CLI (JSON, introspection, auth, doctor, non-interactive mode)
  -> product API
```

Essa separação é importante. A skill não implementa a API, o MCP não é o transporte obrigatório e o `AGENTS.md` não carrega o manual inteiro. Cada camada tem um contrato menor e verificável.

### house-skills inventory

O repositório contém quatro plugins Claude e uma visão unificada portável em `skills/`:

| Plugin | Versão auditada | Skills | Função |
|---|---:|---|---|
| `ai` | 1.2.1 | `agents-md`, `install-md`, `skill-crafting` | contexto always-on, documentação executável e criação/evolução de skills |
| `dev` | 1.1.1 | `address-pr-reviews`, `consult-outside-expert`, `ralph-lisa-loop` | review, consulta externa e execução iterativa |
| `security` | 1.1.1 | `harden-github-actions` | pinning e hardening de GitHub Actions com `zizmor` |
| `recap` | 0.1.1 | `basecamp-activity`, `git-activity`, `github-activity`, `recap` | coleta em átomos diários e síntese por período/audiência |

Total: 11 skills. Os arquivos reais vivem em `plugins/<plugin>/skills`; `skills/` contém symlinks. Isso atende simultaneamente:

- marketplace nativo Claude via `git-subdir`, incluindo hooks;
- outros agentes via `npx skills add basecamp/house-skills`, que dereferencia a visão plana;
- desenvolvimento sem duplicar o conteúdo das skills.

O CI `bin/ci` valida essa topologia: todo symlink resolve, nenhum manifesto declara indevidamente um campo `skills` e nenhum arquivo real é criado na visão plana.

### The opinionated AGENTS.md model

A skill `agents-md` parte de uma premissa correta: instruções do repositório entram em toda sessão antes da primeira pergunta, portanto são o contexto mais caro. Cada linha é classificada:

| Classe | Teste | Ação recomendada |
|---|---|---|
| `OBVIOUS` | derivável de `ls`, `--help` ou convenção do framework | remover |
| `GOTCHA` | específico do repo e custaria uma rodada perdida | manter, começando pelo sintoma |
| `TASTE` | preferência não recuperável pelo código | manter somente quando contraria o prior do modelo |
| `POINTER` | profundidade necessária em alguns casos | apontar para arquivo canônico e quando abri-lo |

Outras regras fortes:

- alvo default de aproximadamente 100 linhas/2,5 mil tokens always-on;
- não repetir README, help, scripts ou regras globais já carregadas;
- preferir paths reais a exemplos inventados;
- manter fora do arquivo estado efêmero de PR, branch, blocker ou tarefa;
- mover profundidade para skills on-demand e regras path-scoped;
- verificar todo comando, path, link, literal e contradição antes de publicar;
- em repositório não confiável, fazer apenas auditoria estática e rejeitar symlinks/traversal;
- `AGENTS.md` é o nome portável; Claude precisa de `CLAUDE.md`/`.claude/CLAUDE.md` importando ou apontando para ele.

Esse modelo deve influenciar red-dev. Instalar RedSkills não basta se os projetos RedDB carregam instruções duplicadas, longas, contraditórias ou não verificadas.

### Skill-crafting flywheel

`skill-crafting` rejeita a ideia de escrever uma skill inteira em abstrato. O processo é:

```text
problema real
  -> v0 mínima
  -> executar em alvo real
  -> observar falha/decisão repetida
  -> atualizar guide/eval/exemplar
  -> executar em outro alvo
  -> repetir até passar cedo e com pouca intervenção
```

Os artefatos amadurecem por uso:

- falha repetida vira eval;
- decisão repetida vira regra;
- output bom vira exemplar;
- explicação grande sai de `SKILL.md` e vai para `references/`;
- tradeoff de design pausa para decisão humana;
- maturidade significa zero H/M aberto e duas rodadas consecutivas sem novos H/M no processo de revisão descrito.

Há sobreposição direta com `dev:write-a-skill`, `dev:audit-skills` e `memory:improve-skills`. A oportunidade não é copiar outra skill de criação: é adotar o requisito de exemplares reais e evals executáveis como contrato comum do ecossistema RedSkills.

### Ralph–Lisa: the strongest and most coupled idea

O Ralph–Lisa loop é o elemento mais opinionado do repositório:

```text
implement
  -> self-review independente
  -> review externo por Codex
  -> reconciliation
  -> synthesis
  -> derived close gate
  -> nova rodada ou encerramento
```

Papéis:

- Claude como orquestrador;
- subagente planner/implementer;
- subagente self-reviewer read-only;
- Codex como reviewer externo independente;
- humano como autoridade de steering e decisões obrigatórias.

O usuário escolhe um `rope length` de 0 a 5. O número muda apenas quando o loop interrompe o humano; não reduz o padrão de qualidade. Mesmo em rope 5, autorização externa, mudança de escopo, ação destrutiva/irreversível, segurança/autenticação e ausência de convergência continuam sendo escaladas obrigatórias.

O close gate é derivado dos registros de findings e disputes, não de contadores mutáveis:

```text
close = open_findings == 0
     && open_disputes == 0
     && implementation_complete
     && eval_passed
```

Se cache e derivação divergem, o gate falha fechado. Findings recebem IDs, estado, evidência e cadeia `supersedes`; três rodadas sem resolver a mesma cadeia forçam intervenção humana. O log preserva as três rodadas mais recentes e compacta histórico antigo depois da oitava.

O Codex é acessado preferencialmente por MCP, mantendo a thread entre rodadas. Porém o desenho exige fallback explícito:

1. tentar MCP;
2. repetir uma vez em erro/timeout;
3. usar `codex exec` somente após opt-in;
4. cair para self-review somente naquela rodada, registrar finding M e tentar restaurar MCP na próxima;
5. nunca degradar silenciosamente.

Esse é o padrão mais relevante para `castle`, `navigator` e `rsp`: um MCP quebrado deve reduzir capacidade de forma visível e recuperável, não impedir todo o ambiente de iniciar nem fingir readiness.

### Product accessibility: API + CLI + skill, not MCP-first

O Basecamp CLI mostra como a 37signals torna um produto acessível a agentes:

| Capacidade | Contrato exposto |
|---|---|
| output | humano no TTY; JSON quando pipe; `--json`, `--quiet`, `--agent`, `--md` explícitos |
| envelope | `{ok, data, summary, breadcrumbs, meta}` |
| descoberta | todo comando suporta `--help --agent`; catálogo completo em `basecamp commands --json` |
| navegação | `breadcrumbs` devolvem próximos comandos válidos |
| não interação | `--agent` e `BASECAMP_NONINTERACTIVE=1` transformam prompts em erros acionáveis |
| filtro | `--jq` embutido evita dependência/processo externo e opera sobre o envelope |
| diagnóstico | `basecamp doctor --json` inclui saúde, auth, conectividade e integração Claude/Codex |
| autenticação | OAuth 2.1, refresh, device flow/fallback e perfis isolados |
| segurança de repo | authority keys em `.basecamp/config.json` são bloqueadas até `basecamp config trust` |
| integração | plugins nativos Claude/Codex; skill genérica para qualquer agente que execute shell |

A skill publicada cobre 155 endpoints e registra invariantes, decision trees, paginação, defaults, erros e workflows. Ela é sincronizada automaticamente do `basecamp-cli` em cada release. Isso evita o drift clássico em que o binário muda e a skill continua ensinando flags antigas.

O `install.md` também é escrito para execução por agente: `OBJECTIVE`, `DONE WHEN`, checklist, steps, verificação após cada step e uma seção manual explicitamente proibida sem solicitação. É documentação como protocolo verificável, não tutorial narrativo.

### How this changes the MCP diagnosis

O modelo 37signals não prova que MCP seja ruim. Ele define melhor seu lugar:

- CLI é o contrato universal e debuggable;
- skill é progressive disclosure e conhecimento de workflow;
- plugin adiciona ergonomia específica do host;
- hook impõe comportamento quando o host suporta;
- MCP é canal de alta integração, mas deve ter equivalente CLI ou degradação clara;
- `doctor --json` mede readiness em vez de assumir que um processo iniciou corretamente.

Para red-dev, todo MCP gerenciado deveria publicar a mesma máquina de estados:

```text
not_installed
  -> installed
  -> configured
  -> transport_started
  -> initialized
  -> smoke_passed
  -> ready

qualquer falha
  -> degraded(reason, fallback, remediation)
```

`process exists` ou `command found` não deve significar ready. O erro exibido no início desta pesquisa — broken pipe durante `initialize` — é exatamente uma falha entre `transport_started` e `initialized`.

### Direct comparison with RedSkills

| Dimensão | house-skills/37signals | RedSkills/red-dev | Leitura |
|---|---|---|---|
| amplitude | 11 skills muito focadas | coleção muito maior: engenharia, memória, brain e operação | RedSkills é plataforma mais ampla |
| distribuição | quatro plugins Claude + Agent Skills genéricas | bundles/plugins para cinco hosts no v3 | RedSkills cobre mais hosts nativamente |
| fonte única | arquivos reais por plugin, symlinks para visão plana | bundles próprios por host | ambos combatem duplicação, com mecanismos distintos |
| instruções de repo | skill específica, budget e auditoria de literals/paths | `dev:context` e setup, sem o mesmo contrato editorial explícito | incorporar princípios `agents-md` |
| criação de skills | flywheel por alvo real + exemplares + evals | write/audit/telemetry/improve | unir evals locais à telemetria RedSkills |
| execução autônoma | Ralph–Lisa com rope 0–5 e close gate derivado | manager/implement/afk/code-review | RedSkills é mais operacional; Ralph–Lisa tem gate mais formal |
| segunda opinião | Codex fixo como reviewer de Claude | multi-agent/review dependente do fluxo | evitar acoplamento fixo a vendors |
| product tooling | CLI estruturado + skill gerada por release | ferramentas RedDB instaladas, mas sem contrato agent CLI uniforme | maior oportunidade prática |
| MCP | opcional no review, `codex exec` fallback | MCPs centrais podem falhar no startup | adotar fallback e readiness estruturado |
| trust boundaries | aparecem em AGENTS e skills que processam input externo | guardrails existem, mas variam por skill | normalizar no schema/auditoria |

### Internal contradictions and limits in the 37signals design

A iniciativa é forte, mas não deve ser copiada sem crítica:

1. A própria referência `agents-md` afirma que `triggers:` não faz parte do Agent Skills spec nem da documentação Claude; várias skills do mesmo repositório ainda carregam listas extensas de `triggers`. Isso é drift interno documentável.
2. Plugins completos são Claude-first. Outros agentes recebem standalone skills, mas não recebem automaticamente o stop hook nem toda a ergonomia do plugin.
3. Ralph–Lisa fixa Claude como orquestrador, Codex como reviewer e `xhigh` como política. É uma boa implementação concreta, mas não um protocolo vendor-neutral.
4. `house-skills` não publica tags/releases; instalar da branch principal reduz reprodutibilidade. Os manifests têm versões, porém o consumo genérico não está pinado.
5. O loop gera estado em `tmp/ralph-lisa-loop-session.md`; o guia manda apagar ou ignorar, mas o repositório não consegue impor isso nos consumidores. Há risco de commit acidental de conteúdo sensível.
6. O modo de auditoria não confiável é seguro, porém operacionalmente rígido: se o `AGENTS.md` alvo já influenciou a sessão, a skill exige recomeçar em cwd neutro.
7. Evals estruturais detectam formato e estado, não garantem semântica. O próprio material reconhece que um exemplar existente pode deixar de exemplificar e que uma flag real pode estar descrita incorretamente.
8. O Basecamp CLI continua exigindo autenticação humana e credenciais; “autônomo” não elimina HITL nem justifica ampliar scope de acesso.

### What red-dev should adopt

Adotar:

1. `AGENTS.md` como contexto mínimo, auditável e portátil; CLAUDE bridge explícita.
2. CLI-first para todas as capacidades RedDB, com `--json`, `--agent`, `--help --agent`, non-interactive e exit codes estáveis.
3. `doctor --json` com estados de readiness completos para agentes, plugins, hooks e MCPs.
4. Skills geradas/testadas junto à release do CLI, não mantidas manualmente em outro ritmo.
5. `install.md` executável com objective/done-when/checkpoints para red-dev e produtos RedDB.
6. Close gates derivados de registros reais, falhando fechados em inconsistência.
7. Trust boundaries obrigatórias para skill que lê issue, PR, web, MCP, chat ou output de outro modelo.
8. Fallback MCP → CLI registrado, testado e visível no doctor.
9. Evals executáveis e exemplares reais como requisito de maturidade de skill.
10. Um nível de autonomia simples, com escaladas obrigatórias invariantes.

Não adotar literalmente:

1. vendor lock Claude-orchestrator/Codex-reviewer;
2. listas `triggers:` não portáveis como mecanismo de ativação;
3. branch `main` mutável como canal padrão de produção;
4. mais uma coleção paralela de skills que duplique RedSkills;
5. MCP como requisito para um fluxo cuja operação básica cabe em CLI;
6. logs de sessão dentro do repo sem lifecycle e política de dados.

### Proposed RedDB agent-accessibility contract

Cada CLI RedDB deveria satisfazer o mesmo contrato:

```text
<tool> commands --json
<tool> <command> --help --agent
<tool> doctor --json
<tool> auth status --json        # quando aplicável
<tool> ... --agent              # output estável, sem prompt
<tool> ... --dry-run            # para mutações relevantes
```

Cada integração de host/MCP deveria declarar:

```text
install -> configure -> start -> initialize -> smoke -> ready
                                          \-> degraded + fallback + remediation
```

E cada release deveria publicar, como uma unidade compatível:

- binário;
- schema/command catalog;
- Agent Skill;
- plugin adapters;
- checksum/provenance;
- testes de drift entre comandos e skill;
- versão mínima do host/hook/MCP.

Isso aproveita o melhor da iniciativa do DHH sem enfraquecer o diferencial do RedSkills: uma camada universal de engenharia, memória e conhecimento por cima de ferramentas RedDB realmente agent-accessible.

## Update, migration and supply-chain comparison

### Omakub

- `Omakub > Update > Omakub` faz `git pull` no checkout;
- compara timestamp do último commit anterior com nomes de migrations;
- executa migrations novas em ordem;
- menu oferece atualização manual de Ollama, LazyGit, LazyDocker, Neovim e Zellij;
- packages apt/Flatpak continuam sob mecanismos Ubuntu;
- migrations podem substituir configs e pedir interação/logout;
- bootstrap remove o checkout anterior antes de clonar novamente.

### red-dev

- `update` executa `apt full-upgrade/autoremove` ou `winget upgrade --all`;
- reexecuta instalador RedSkills;
- converge o manifesto;
- possui duas migrations de reparo de fonte com ledger em preferences;
- não atualiza o próprio binário;
- não mantém rollback do binário/config;
- releases têm checksums e provenance, mas os installers não verificam checksum;
- downloads `gh` de dependências também não validam checksums publicados.

### Preference/state bug affecting upgrades

O first run grava theme, font e fontSize. Depois dele:

- `contextFor()` monta o contexto a partir dos defaults CLI, não de `readPreferences()`;
- `red-dev update` chama converge com esses defaults;
- `red-dev theme <outro>` usa o nome pedido, mas mantém fonte/tamanho defaults;
- o estado declarado e o estado aplicado podem divergir silenciosamente.

Isso precisa ser P0 porque torna update potencialmente regressivo para preferências visuais.

### Required update contract

```text
resolve channel/version
  -> download platform+arch asset
  -> verify SHA256 + provenance/signature
  -> stage next binary
  -> run preflight
  -> atomically swap
  -> run migrations
  -> converge persisted desired state
  -> doctor/readiness
  -> retain previous binary/config snapshot for rollback
```

## Platform matrix and macOS feasibility

### Actual support today

| Capability | Ubuntu 24 | Ubuntu 26 | WSL | Windows x64 | macOS Intel | macOS ARM |
|---|---|---|---|---|---|---|
| red-dev release binary | sim | mesmo asset, não validado | sim | sim | não | não |
| bootstrap | sim | sim conceitual | sim | PowerShell | não | não |
| provider package manager | apt | apt com gaps | apt + winget | winget | **cai em apt/u24** | **cai em apt/u24** |
| desktop integration | parcial GNOME | não validada | host Windows | parcial | não | não |
| architecture | x64 | x64 | x64 | x64 | — | — |
| E2E clean-machine | parcial/manual | não | melhor exercitado | bootstrap não validado clean | não | não |

### macOS is technically tractable

A consulta oficial Homebrew encontrou formulas para todos estes itens do core/optional: Git, curl, unzip, ripgrep, fd, bat, eza, zoxide, fzf, btop, jq, Starship, Atuin, Carapace, direnv, git-delta, yazi, tealdeer, fastfetch, gh, LazyGit, LazyDocker, Zellij, mise, Neovim, just, duf, dust, hyperfine, glow e gitui.

Há casks oficiais para Alacritty, Docker Desktop, VS Code, Blender e as quatro Nerd Fonts escolhidas pelo red-dev. As ferramentas RedDB já oferecem assets macOS Intel/ARM.

Portanto, macOS não exige inventar distribuição da stack; exige implementar:

- `Env = "macos"` e capacidades próprias;
- providers `brew`, `cask`, `gh-dmg`, `gh-binary`, `builtin-macos`;
- release targets Darwin x64/arm64;
- bootstrap universal;
- paths/config/shell;
- instalação/registro de apps DMG;
- hotkeys, tiling, launcher, dark/accent/wallpaper;
- testes em Intel e Apple Silicon.

### Immediate safety fix

Antes de qualquer suporte macOS, `providerFor()` deve rejeitar Darwin. Tentar `apt` em macOS é pior que declarar unsupported.

## First-run experience

### Omakub sequence

1. valida Ubuntu/arquitetura;
2. pergunta apps opcionais;
3. pergunta linguagens;
4. pergunta bancos;
5. coleta identificação Git;
6. instala terminal;
7. instala desktop e customiza GNOME;
8. oferece reboot.

O usuário termina com uma opinião forte aplicada. O custo é que uma falha aborta tudo e vários arquivos são substituídos.

### red-dev sequence

1. em Windows/WSL, oferece config compartilhada e shell destino;
2. preselect Claude/Codex/OpenCode;
3. preselect Node LTS;
4. preselect optional CLI tools compatíveis;
5. deixa ble.sh off;
6. escolhe Nerd Font;
7. escolhe tema com preview;
8. converge core/desktop/WSL e escolhas.

O fluxo é mais sofisticado para cross-platform e agentes, mas o resultado desktop é menor. Não pergunta workstation apps, browser, editor baseline, bancos, hotkey profile ou tiling profile.

### Recommended profiles

| Profile | Conteúdo |
|---|---|
| `minimal` | shell, Git, terminal, mise, Node, CLI essencial |
| `desktop` | minimal + browser, editor baseline, fonts, themes, hotkeys, tiling, launcher, screenshots, web apps |
| `reddb-employee` | desktop + `red`, `tq`, red-request, dit, red-ui, RedSkills e agentes corporativos |
| `ai-heavy` | reddb-employee + conjunto amplo de agentes, Ollama e extensões |

Perfis devem ser intenção persistida. Remover um item do perfil é uma escolha registrada, não drift. Itens pessoais continuam fora da propriedade do red-dev.

## Critical gaps ranked

### P0 — correctness and honesty

1. Darwin não pode usar provider Ubuntu.
2. Persisted theme/font/fontSize precisam alimentar todo `plan/install/update/theme`.
3. Corrigir os sete adapters Neovim e seus nomes de colorscheme.
4. Tratar Rose Pine como light no GNOME e Windows.
5. Corrigir red-ui Windows de skip para asset real.
6. Instalar e verificar Nerd Font no Ubuntu, Windows e futuro macOS.
7. Instalar `wl-clipboard` antes de configurar `wl-copy`.
8. Conectar ou remover funções mortas: web apps e fzf colors.
9. Mostrar matriz real de superfície por tema na UI.
10. Implementar self-update verificado e rollback.

### P0 — RedDB employee readiness

1. Adicionar Pi.
2. Atualizar RedSkills v2 → v3.
3. Verificar Pi e Gemini no doctor.
4. Criar caminho oficial RedSkills para Hermes.
5. Instalar todos os assets RedDB disponíveis por plataforma/arch.
6. Adicionar smoke tests reais, inclusive MCP startup.
7. Exibir auth-required separadamente de failed.

### P1 — desktop parity with Omakub

1. Browser Chromium-family.
2. VS Code baseline seguro e LazyVim starter governado.
3. GNOME extensions, Tactile, launcher, workspaces, dock e app grid.
4. Screenshots e clipboard.
5. Web apps integrados ao CLI/TUI.
6. Bancos/serviços Docker selecionáveis.
7. Catálogo workstation em profile, não no core.
8. Templates/launchers RedDB próprios com ícones.

### P1 — cross-platform interaction model

1. Semantic hotkey schema.
2. GNOME adapter.
3. PowerToys/FancyZones adapter e export de configuração.
4. macOS tiling/launcher ADR + adapter.
5. Conflict detection e generated cheat sheet.

### P2 — visual system and assets

1. Theme manifest com status exact/approximate/follow-system/unsupported por superfície.
2. CI exigindo adapter completeness para tema novo.
3. Versionar os dez wallpapers gerados.
4. Metadata de wallpaper e assets art-directed opcionais.
5. Font manifest com install/apply/verify por OS.
6. Ícones e launchers consistentes para red-dev e produtos RedDB.

## Proposed internal contracts

```ts
interface DesiredProfile {
  id: "minimal" | "desktop" | "reddb-employee" | "ai-heavy";
  tools: string[];
  agents: string[];
  runtimes: string[];
  services: string[];
  theme: string;
  font: { family: string; size: number };
  hotkeyProfile: string;
  tilingProfile: string;
}

interface Installable {
  id: string;
  supports(platform: Platform): Support;
  plan(desired: DesiredState): Promise<PlanStep[]>;
  apply(step: PlanStep): Promise<void>;
  verify(desired: DesiredState): Promise<HealthResult>;
  uninstall?(): Promise<void>;
}

interface ThemeSurface {
  id: string;
  support(theme: Theme, platform: Platform):
    | "exact"
    | "approximate"
    | "follow-system"
    | "unsupported";
  apply(theme: Theme, platform: Platform): Promise<void>;
  verify(theme: Theme, platform: Platform): Promise<HealthResult>;
}

interface SkillHostAdapter {
  id: "claude" | "codex" | "opencode" | "gemini" | "pi" | "hermes";
  install(): Promise<void>;
  wireRedSkills(version: string): Promise<void>;
  verifySkills(): Promise<HealthResult>;
  verifyMcp(): Promise<HealthResult>;
  update(): Promise<void>;
}
```

## Acceptance criteria and E2E matrix

### Per platform

| Target | Required lane |
|---|---|
| Ubuntu 24 desktop x64 | clean VM + GNOME session |
| Ubuntu 26 desktop x64 | clean VM + GNOME session |
| Ubuntu server x64 | headless |
| WSL Ubuntu 24 | Windows host crossing |
| Windows 11 x64 | clean VM, no preinstalled Git/Bun |
| macOS Intel | clean runner/hardware |
| macOS ARM | Apple Silicon runner/hardware |

### Test sequence

1. bootstrap verified by checksum;
2. apply `reddb-employee`;
3. capture plan/result/readiness;
4. run second converge and assert zero unexpected mutations;
5. verify every binary/app/agent/MCP;
6. change all ten themes and inspect declared surfaces;
7. change all fonts and preserve size through theme/update;
8. exercise semantic hotkeys;
9. start selected databases;
10. update N-1 → current;
11. rollback;
12. uninstall selected item without deleting unrelated configuration.

### Agent accessibility and MCP sequence

1. enumerar comandos e schemas sem executar mutações;
2. executar cada CLI em `--agent`/non-interactive e validar JSON + exit code;
3. instalar a skill da mesma versão do CLI e testar drift de comandos/flags;
4. verificar `AGENTS.md`/Claude bridge e budget always-on;
5. exercitar MCP até `initialize` e smoke funcional, não apenas spawn do processo;
6. matar o MCP durante uma operação e confirmar estado `degraded` + fallback CLI;
7. restaurar o MCP e confirmar reconexão sem reinstalar o ambiente;
8. injetar conteúdo hostil por issue/PR/MCP e confirmar que é tratado como dado, não instrução;
9. verificar que actions remotas, auth e mudanças destrutivas continuam exigindo autoridade adequada;
10. executar N-1 CLI com skill N e vice-versa para provar que incompatibilidade falha com diagnóstico acionável.

### SLOs

- setup concluído em até 30 minutos, descontando autenticação humana;
- no máximo um reboot/sign-out;
- segundo converge sem drift;
- 100% dos itens escolhidos em `healthy`, `auth-required` ou `unsupported-with-reason`;
- nenhum “success” baseado somente em arquivo existente;
- todo tema novo passa completeness checks;
- N-1 update e rollback comprovados antes da stable.

## API / CLI / Config Details

```text
red-dev profile list
red-dev profile show reddb-employee
red-dev profile apply reddb-employee --plan
red-dev self-update --channel stable
red-dev rollback
red-dev theme matrix
red-dev hotkeys list
red-dev hotkeys conflicts
red-dev services
red-dev agents doctor
red-dev agents doctor --json
red-dev mcp doctor --json
red-dev mcp status --json
red-dev tools doctor
red-dev doctor --readiness
red-dev webapps
```

`red-dev update` deve continuar sendo o caminho feliz, orquestrando self-update, migrations, converge do desired profile e readiness.

Config ownership deve ser explícito:

| Mode | Significado |
|---|---|
| owned | arquivo inteiro gerado e atualizável |
| merged | somente chaves declaradas pertencem ao red-dev |
| adopted | config existente foi importada após consentimento |
| external | red-dev apenas verifica/orienta |

## Version Notes

- O checkout red-dev declara `0.19.0`; a stable mais recente é `v0.17.1`, publicada em 2026-08-02.
- Omakub master auditado continua em `1.5.0`; a release foi publicada em 2025-11-09.
- O manual Omakub fala em sete temas, mas o código possui dez.
- O manual Omakub fala em workspaces 1–4, mas o código configura 1–6.
- RedSkills latest é `v3.3.18`; red-dev chama explicitamente o major tag v2.
- `house-skills` foi auditado em `d2d85ab` e não possui tags/releases; seus manifests internos declaram `ai 1.2.1`, `dev 1.1.1`, `security 1.1.1` e `recap 0.1.1`.
- `basecamp-cli v0.8.0` e `basecamp/skills` sincronizada dessa release foram auditados em 2026-08-03; a superfície muda rapidamente e precisa ser pinada por commit/release em qualquer adoção.
- Os releases RedDB consultados são atuais na data do relatório e podem ganhar novos assets; o manifesto deveria consumir uma contract manifest publicada por cada produto, em vez de manter frases manuais como “não há Windows build”.

## Gotchas

- “Instalado” não significa configurado, autenticado ou saudável.
- “Tema suporta Neovim” não significa que o plugin do colorscheme foi instalado.
- “Zellij resolve tiling” só vale dentro do terminal.
- Uma preference persistida que não alimenta o próximo converge é documentação, não desired state.
- Dark/light deve ser propriedade do tema, não suposição global.
- Um asset existir na release não garante silent install; DMG/MSI/NSIS precisam de adapters próprios.
- O catálogo desktop deve ser profile-driven para não transformar o core em uma instalação de dezenas de GB.
- Não sobrescrever VS Code/Neovim existentes silenciosamente.
- Hotkeys globais precisam de conflict detection; uma tecla global pode quebrar browser/editor.
- macOS deve falhar fechado até o provider existir.
- Downloads devem verificar hash/proveniência antes de executar.
- Plugin instalado não garante equivalência entre hosts: hooks e lifecycle Claude podem não existir no modo standalone Agent Skills.
- MCP que deu spawn mas falhou no handshake não está ready; a granularidade precisa alcançar `initialize` e smoke.
- `triggers:` extensos não são mecanismo portável de ativação segundo a própria referência `agents-md`; a description continua sendo o contrato interoperável.
- Output de outro agente ou reviewer é input não confiável e não deve ser executado como instrução.

## Open Questions

1. Quais apps são obrigatórios no perfil `reddb-employee`?
2. Chrome, Brave ou Edge será o browser padrão por plataforma?
3. O baseline editor corporativo inclui VS Code, Neovim ou ambos?
4. O template editorial será owned ou um starter adotável?
5. Quais bancos são default para colaboradores RedDB?
6. Quais agentes são mandatory, recommended e experimental?
7. Hermes deve receber integração oficial dentro de RedSkills antes de entrar no perfil?
8. Qual ferramenta macOS será padrão para tiling e launcher?
9. O macOS usará Bash por paridade ou Zsh por natividade?
10. Quais wallpapers podem ser distribuídos com licença/proveniência explícita?
11. PowerToys será obrigatório no Windows ou apenas adapter optional?
12. Como credenciais corporativas serão guiadas sem serem armazenadas pelo red-dev?
13. Quais CLIs RedDB serão priorizados para o contrato `--agent`/`doctor --json`?
14. MCP será obrigatório, preferred ou optional-with-fallback por capacidade?
15. Qual matriz de compatibilidade vai pinçar CLI, skill, plugin, host e protocolo MCP?
16. O nível de autonomia será global, por perfil ou por operação?

## Source-by-Source Notes

### red-dev source notes

- `manifest.ts` é um bom source of truth, mas ainda mistura instalação, alcance de desktop e assumptions de asset que ficam stale.
- `themes.ts` centraliza paletas, mas o schema não exige mode light/dark, plugin Neovim ou adapter coverage.
- `theme-apply.ts` possui um ramo Windows que reduz indevidamente as superfícies.
- `theme-editors.ts` tem mappings VS Code bons e host-aware, mas não suporta JSONC e força dark no GNOME.
- `theme-cli.ts` melhora o Omakub em CLI, porém `fzfColors()` está morto.
- `preferences.ts` persiste escolhas corretas; `main.ts/contextFor()` não as consome nos próximos comandos.
- `webapps.ts` é uma implementação competente sem product route.
- `agents.ts` tem catálogo amplo, porém usa RedSkills v2 e mantém doctor de apenas três hosts.
- `providers.ts` tem bom matching de assets e timeout, mas não verifica checksums e não faz self-update.
- release pipeline produz checksums/attestation e dois targets x64; os bootstraps não consomem a verificação.

### Omakub source notes

- Omakub maximiza coerência escolhendo um único OS/desktop.
- O catálogo de workstation é muito mais amplo e aplicado automaticamente.
- Cada tema é um bundle completo e autocontido.
- GNOME/hotkeys/tiling/dock formam um interaction model, não uma lista de tweaks.
- LazyVim e VS Code deixam o usuário produtivo imediatamente.
- Scripts substituem configs e `set -e` aborta o restante; é menos resiliente que red-dev.
- Self-update e migrations fecham um ciclo que o red-dev ainda não fecha.

### DHH/37signals agent source notes

- `house-skills` separa conteúdo físico por plugin e expõe uma visão plana por symlink; essa inversão existe porque o marketplace extrai subdiretórios.
- `agents-md` é a contribuição mais universal: gastar contexto always-on somente com gotchas, counter-priors e pointers verificáveis.
- `skill-crafting` conecta instrução, alvo real, exemplar e eval; a maturidade é evidenciada por execução, não por tamanho da documentação.
- Ralph–Lisa formaliza autonomia sem relaxar o close gate, mas é deliberadamente acoplado a Claude + Codex.
- O stop hook impede encerramento durante loop ativo somente no plugin Claude; standalone skills não herdam automaticamente essa garantia.
- Trust boundaries são explícitas: PR comments, conteúdo externo e output de modelo permanecem dados não confiáveis.
- `basecamp-cli` demonstra a arquitetura agent-accessible mais concreta: JSON estável, breadcrumbs, introspecção, non-interactive, auth profiles, config trust e doctor.
- `basecamp/skills` é sincronizado a cada release do CLI, padrão que RedDB deveria adotar para evitar drift entre binário e skill.
- A estratégia pública do DHH é supervised collaboration: agentes produzem contribuições reais, mas revisão, guidance e decisões continuam humanas.
- Manual e código divergiram em temas e workspaces, mostrando a necessidade de docs geradas.

### RedSkills source notes

- v2 já suporta Claude, Codex, OpenCode e Pi.
- v3 adiciona Gemini e mantém Pi packages publicados.
- Hermes não aparece como host oficial.
- O source atual possui release assets para OpenCode, Pi packages, VS Code e Herdr plugin.

### RedDB release notes

- Os cinco produtos principais já publicam cobertura maior que o red-dev consome.
- red-ui Windows é o exemplo mais claro de provider stale.
- assets macOS e ARM reduzem muito o custo de implementar o novo provider.

## Recommended Next Steps

### Immediate remediation tickets

1. `fix(platform): reject darwin until a mac provider exists`
2. `fix(preferences): hydrate ApplyContext from persisted theme/font/fontSize`
3. `fix(theme): make light/dark explicit and correct Rose Pine`
4. `fix(theme): install exact Neovim plugin/config for every theme`
5. `fix(theme): restore CLI surfaces on native Windows`
6. `fix(font): install and verify Nerd Fonts on Ubuntu and Windows native`
7. `fix(clipboard): add wl-clipboard to desktop manifest`
8. `fix(red-ui): consume current Windows release asset`
9. `feat(agent): add Pi and RedSkills verification`
10. `chore(red-skills): move universal installer from v2 to v3`
11. `feat(webapps): wire catalog into CLI/TUI and add browser dependency`
12. `feat(update): verified atomic self-update and rollback`
13. `feat(mcp): model install/configure/initialize/smoke/readiness and explicit CLI fallback`
14. `feat(agent-cli): standardize --agent, --help --agent, doctor --json and non-interactive behavior`
15. `test(skills): generate/version product skills with their CLI releases and fail on command drift`
16. `docs(agents): add verified minimal AGENTS.md plus Claude bridge and agent-executable install.md`

### Product epics

1. RedDB Employee Profile.
2. Theme/Font Contract.
3. Semantic Hotkeys and Cross-platform Tiling.
4. Desktop Linux Parity.
5. macOS Intel/ARM.
6. Clean-machine E2E Fleet.
7. Generated Capability and Asset Documentation.
8. RedDB Agent Accessibility: CLI contracts, generated skills, host plugins, MCP fallback and readiness.

## Final assessment

O primeiro relatório estava errado em profundidade porque comparava intenções e arquitetura, não o produto que realmente chega à máquina. A inspeção completa muda a conclusão de forma importante.

O red-dev é mais avançado como engine. Omakub é mais avançado como workstation. Hoje, dizer que o red-dev é a evolução espiritual do Omakub é uma direção de produto, não ainda uma descrição completa da experiência entregue.

A boa notícia é que a base mais difícil já existe: providers, convergência, WSL/Windows, state, doctor, temas como dados, releases e produtos RedDB multiplataforma. Os gaps encontrados são concretos e planejáveis. Corrigir correctness primeiro, transformar o setup RedDB em profile verificável e depois portar o interaction model completo do Omakub permitirá ao red-dev superar o original sem perder seu diferencial: uma estação coerente, atualizável e recuperável em qualquer sistema suportado.
