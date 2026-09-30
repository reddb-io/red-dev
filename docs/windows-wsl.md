# Windows coordena Windows e Ubuntu/WSL

No Windows, execute o red-dev pelo PowerShell. O modo padrão configura o host
gráfico e uma distribuição Ubuntu com WSL 2 na mesma execução.

```powershell
red-dev install
red-dev update
red-dev doctor
```

No Ubuntu nativo, esses comandos configuram apenas o próprio Ubuntu.

## Onde cada componente fica

| Componente | Windows com WSL | Ubuntu nativo |
| --- | --- | --- |
| Alacritty, fontes e atalhos | Windows | Ubuntu |
| Codex Desktop, Claude Desktop, Antigravity, VS Code | Windows, escolhidos em `red-dev apps` | Ubuntu, escolhidos em `red-dev apps` |
| Bash, Zellij e ferramentas de terminal | Ubuntu/WSL | Ubuntu |
| Linguagens escolhidas em `red-dev lang` | Ubuntu/WSL | Ubuntu |
| Agentes CLI, como Codex e Claude Code | Ubuntu/WSL | Ubuntu |
| red-dev e RedCode | Windows e Ubuntu/WSL | Ubuntu |
| redskilled e RedRouter | Ubuntu/WSL | Ubuntu |

O Windows conserva Node e o conteúdo RedSkills necessário para integrar o
RedCode local. Isso não instala outro daemon redskilled no Windows. Os comandos
Windows `redskilled`, `redskilled-mcp` e `red-router` usam pontes para a distribuição
selecionada. Para projetos e Workers Linux, abra o RedCode dentro do WSL.

`red-dev agents update`, `red-dev agents run`, `red-dev lang`, o diagnóstico e os
reparos encaminham o trabalho Linux ao WSL. `red-dev apps` também oferece abrir
o catálogo de aplicativos Ubuntu/WSL. `red-dev install optional` instala os
itens opcionais em seus respectivos destinos.

## Distribuição e primeiro uso

Uma distribuição registrada nas preferências tem prioridade. Sem escolha
registrada, o red-dev usa o Ubuntu padrão ou o primeiro Ubuntu disponível;
`docker-desktop` não é selecionado. Se faltar Ubuntu, instala Ubuntu-24.04.
Um Ubuntu-26.04 já instalado também pode ser utilizado.

O Windows pode pedir autorização de administrador e reinicialização ao ativar
WSL. A primeira inicialização do Ubuntu pede usuário e senha. Depois desses
passos do sistema operacional, execute novamente `red-dev install` no
PowerShell. Não é necessário instalar o red-dev manualmente dentro do Ubuntu.
O coordenador exige WSL 2, usuário Linux diferente de root e serviços ativos.
Se o systemd não estiver disponível, o diagnóstico explica a etapa pendente;
o instalador não encerra a distribuição nem os trabalhos para habilitá-lo.

Uma preferência explícita por Git Bash mantém o modo Windows nativo existente.
Use `red-dev shell` para escolher Ubuntu/WSL e configurar o par. Não execute o
red-dev inteiro como root ou administrador; os provedores pedem os privilégios
necessários durante o trabalho.

## Atualização de instalações antigas

O red-dev preserva uma cópia consistente do banco RedRouter, incluindo WAL,
arquivos de configuração e a chave de criptografia disponível no ambiente.
Importa essa cópia somente se o diretório de dados do WSL estiver vazio. Dados
existentes no WSL e os originais Windows permanecem preservados. As cópias ficam
em `%USERPROFILE%/.local/state/red-dev/windows-wsl`.

Somente depois de configurar e verificar o lado Linux, o coordenador desativa
as entradas nativas de serviços comprovadamente geradas pelo red-dev, guarda
os originais e cria as pontes. Workers ativos ou de estado desconhecido impedem
a transição do daemon. Arquivos com autoria desconhecida são preservados e a
execução informa o impedimento. Uma falha pode ser corrigida e a instalação
repetida. Dados, logs e runtimes do antigo redskilled não são apagados.

Serviços no WSL não fornecem automaticamente ícones na bandeja do Windows.
Sua saúde é verificada pelo systemd no Ubuntu e pelo `red-dev doctor`.

## GitHub autenticado para mise

Durante a coordenação, a identidade do `gh` Windows é encaminhada apenas no
ambiente do processo filho. Para `mise upgrade` e `mise bump` executados depois
dentro do WSL, o helper tenta o `gh` Linux e consulta o `gh` Windows se o local
não estiver autenticado. Nenhum token é salvo pelo red-dev nem passado em argv.
Consulte [o diagnóstico de mise e GitHub](mise-github-auth.md).
