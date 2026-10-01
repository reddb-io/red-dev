# Perfis e plano de instalação

O perfil registra a configuração desejada. O catálogo oferece ferramentas;
selecionar uma ferramenta e escolher quem a mantém são decisões separadas.
`red-dev policy` continua sendo o dono de `follow`, `fixed` e `external`.

## Comandos

```sh
red-dev profile                  # mostra o perfil, sem escrever arquivos
red-dev profile adopt            # registra as escolhas atuais, sem instalar pacotes
red-dev profile disable docker   # deixa de gerenciar; preserva o pacote existente
red-dev profile enable docker
red-dev plan                     # mostra ações, destino, política e direitos necessários
red-dev install                  # aplica as decisões do mesmo planejador
```

`red-dev profile use <nome>` escolhe entre `ubuntu-desktop`, `ubuntu-server`,
`ubuntu-wsl`, `windows-wsl` e `windows-native`. Perfis incompatíveis com o
ambiente são recusados. Alterar o perfil registra intenção; não instala nem
desinstala pacotes. Trocar o Windows para `windows-native` escolhe Git Bash;
`windows-wsl` coordena o Ubuntu selecionado.

## Arquivo declarativo

O caminho é mostrado por `red-dev profile`: `red-dev/profile.json` no diretório
de configuração do usuário. `RED_DEV_PROFILE_FILE` permite um caminho explícito.

```json
{
  "schema": 1,
  "name": "windows-wsl",
  "distro": "Ubuntu-26.04",
  "tools": { "docker": false, "antigravity": true },
  "agents": ["redcode", "codex", "claude-code"],
  "runtimes": ["rust@latest", "node@latest"],
  "apps": ["antigravity"]
}
```

`tools` aceita nomes do manifest. `false` exclui o item da instalação, da
declaração mise gerada e de atualizações gerenciadas. Isso não remove pacotes,
arquivos pessoais nem serviços já em execução. `true` seleciona o item; seu
destino continua vindo da declaração de Windows/Linux/ambos. Desmarcar
RedRouter também deixa de gerenciar seu autostart.

Os perfis definem os escopos básicos. Aplicações opcionais precisam aparecer
em `apps` ou ser habilitadas em `tools`. `red-dev apps`, `agents` e `lang`
continuam atualizando as escolhas do perfil. Credenciais e limites de recursos
não entram no arquivo. Os mecanismos de migração e manutenção permanecem
habilitados para poder retirar defaults antigos de forma segura.

As listas `agents` e `runtimes` podem ser omitidas durante a adoção de uma
máquina antiga, conservando o comportamento anterior. Uma lista explícita
substitui a seleção anterior; pacotes desmarcados permanecem instalados.
Dependências necessárias, como Node para um pacote npm selecionado, aparecem
no plano e respeitam os seletores/políticas existentes do mise.

## Adoção e Windows/WSL

Sem arquivo, o perfil é inferido das preferências existentes. Planos e consultas
não gravam essa inferência. A instalação a registra sem reescrever o arquivo de
preferências antigo; arquivos inválidos são reportados e preservados. Seleções
antigas de OpenCode são normalizadas para RedCode, e Gemini deixa de ser
gerenciado, conservando instalações existentes.

O Windows encaminha o perfil desejado ao WSL pelo ambiente do subprocesso,
separadamente das credenciais. A instalação do filho combina as escolhas
explícitas do Windows com overrides locais que não foram especificados no
Windows. Um Ubuntu nativo ou WSL independente mantém seu próprio perfil.

## O que o plano afirma

As ações são `install`, `upgrade`, `replace`, `reconcile`, `keep`, `skip` e
`unmanage`. `reconcile` significa que um provedor gerenciado determina as
mudanças de configuração; não é uma promessa de que haverá escrita.
Defaults antigos reconhecidos são listados para retirada com backup; donos
desconhecidos são preservados. Nenhuma retirada reinicia workloads do usuário.

O plano não executa `--version` de fornecedores: usa arquivos, PATH e metadados
locais do mise. Versão/identidade sem evidência suficiente é indicada como
reconciliação pelo provedor. Uma lista de destinos para um WSL não observado
nunca afirma que aqueles pacotes estejam instalados.

Isso ainda não é um lock de versões/artefatos nem uma transação de instalação.
A observação pode mudar entre o plano e a instalação; a instalação consulta
novamente o mesmo planejador para decidir sobre o estado atual.
