# Mise com a conta autenticada do GitHub

Uma VPN corporativa pode compartilhar o IP entre muitas máquinas. O limite
REST anônimo do GitHub normalmente é de 60 requests por hora por IP. Usar a
credencial da sessão `gh` permite utilizar o limite da conta, normalmente
5.000 por hora. Máquinas e ferramentas que usam a mesma conta compartilham
esse limite; limites secundários e problemas de rede continuam possíveis.

O novo red-dev configura essa integração durante `red-dev install` e
`red-dev update`. Ele instala um helper persistente, usado pelo próprio mise
em `mise upgrade` e `mise bump`, que resolve o gh atual a cada leitura da
credencial. Upgrades do gh e trocas de conta não exigem refazer a configuração.
Overrides antigos que chamavam `gh auth token` são migrados com backup.
O cache de versões fica em uma hora nas operações comuns.

O fluxo normal só requer uma sessão gh autenticada. Os procedimentos manuais
abaixo são contingência para máquinas com uma versão anterior à correção.

## Linux, WSL ou macOS

Confira a sessão local. Se não estiver autenticada, execute `gh auth login`.

```bash
gh auth status --hostname github.com
```

Resolva o binário real antes de configurá-lo, para evitar usar o shim mise
como comando de credenciais do próprio mise:

```bash
github_cli_bin="$(mise which gh 2>/dev/null || command -v gh)"
mise settings set github.credential_command "\"$github_cli_bin\" auth token --hostname github.com"
mise settings set fetch_remote_versions_cache 1h
mise token github
gh api rate_limit --jq '.resources.core | {limit,remaining,reset}'
```

O comando de credenciais deve ser executado sob o mesmo usuário que fez login
no gh. O token continua no armazenamento gerenciado pelo gh; só o comando é
salvo na configuração mise. Se o caminho do executável mudar após uma
atualização do gh, execute a configuração novamente.

## Windows com PowerShell

```powershell
gh auth status --hostname github.com
$githubCliBin = mise which gh 2>$null
if ($LASTEXITCODE -ne 0) { $githubCliBin = (Get-Command gh.exe).Source }
$githubCliBin = $githubCliBin.Trim().Replace('\', '/')
mise settings set github.credential_command ('"' + $githubCliBin + '" auth token --hostname github.com')
mise settings set fetch_remote_versions_cache 1h
mise token github
gh api rate_limit --jq '.resources.core | {limit,remaining,reset}'
```

O procedimento PowerShell deve ser executado no PC Windows; foi escrito para
a CLI suportada, mas não foi validado em um host Windows nesta avaliação.

## Como interpretar

`mise token github` mostra a fonte e uma credencial mascarada. O resultado
esperado é `source: credential_command`, salvo quando uma variável de token
explícita tiver prioridade. `gh api rate_limit` consulta a credencial do gh;
para atribuir essa cota ao mise, confirme primeiro que ele selecionou o comando
gh, sem override por variável de token.

`MISE_GITHUB_TOKEN`, `GITHUB_API_TOKEN` e `GITHUB_TOKEN` podem substituir o
login do gh. Uma variável com token inválido pode esconder uma sessão válida.
Confira apenas quais nomes estão definidos, sem imprimir os valores.

Após confirmar a autenticação, repita somente a instalação que falhou.
Se o timeout continuar com requests disponíveis, investigue separadamente o
proxy/VPN e os hosts de download da release. Uma falha na transferência não
prova que o limite REST foi atingido. Um `429` também pode ser um limite
secundário ou uma resposta do proxy; os headers da resposta ajudam a atribuir
a causa. Use o tempo de `Retry-After` ou o horário de reset quando informados.
