# Escolhas de recursos

`red-dev resources` abre o diagnóstico e a configuração guiada. Também fica em
**Resources** nos menus. Fora de um terminal, mostra apenas o diagnóstico.
O padrão é usar as configurações existentes do sistema. Instalação, updates e
manutenção não escolhem um orçamento nem reaplicam estas alterações.

## Investigar travamentos

```sh
red-dev resources status
red-dev resources status --json
red-dev doctor --repair workloads
```

O diagnóstico distingue RAM do Windows de memória visível no Linux/WSL. Mostra
swap, pressão de memória PSI, processos Cargo/rustc/rust-analyzer/linker e os
controles dos cgroups atuais e ancestrais. O RSS inclui páginas compartilhadas;
somar as linhas não é uma medida de consumo exclusivo. Contadores de swap e
OOM são cumulativos, não taxas ou provas de um incidente atual.

No Windows, consulta apenas um WSL já em execução: o distro escolhido no
perfil ou o único distro ativo. Não inicia distros parados. O red-dev do Ubuntu
também precisa ter este comando. Dentro do WSL, lê o Windows por PowerShell
com prazo. Dados indisponíveis são marcados como desconhecidos, sem converter
a RAM da VM em uma estimativa da RAM física do host. O JSON exclui o conteúdo
completo do `.wslconfig`, que pode conter valores pessoais não relacionados.

Configurações antigas reconhecidas aparecem com sua origem. A limpeza tem
seu próprio fluxo: `red-dev doctor --repair workloads`, depois `--apply`.
Abra novas shells para descartar funções antigas já carregadas. Um valor sem
marcador de dono continua preservado; o diagnóstico não o atribui ao red-dev.

## Escolher um orçamento do WSL

```sh
# Prévia. Execute no Windows ou no Ubuntu/WSL.
red-dev resources configure custom --memory 24 --swap 4
# Salva exatamente a escolha indicada.
red-dev resources configure custom --memory 24 --swap 4 --apply
```

Os números estão em GiB. Para 32 GiB de RAM, o modo `responsive` sugere um
ponto inicial de 24 GiB, após observar o host, e swap de 4 GiB. A interface
permite editar os valores e exige confirmação da prévia. Fora da interface:

```sh
red-dev resources configure responsive
red-dev resources configure responsive --apply
```

O teto vale para a VM WSL 2, compartilhada por seus distros. Não é uma reserva
de RAM para Windows nem uma garantia de que o Linux não enfrentará OOM ou
swap excessivo. Nenhum orçamento é dividido por aba. Se os dados do Windows
não estiverem disponíveis, o preset não adivinha o tamanho do host; use uma
escolha explícita em `custom` após verificar a máquina.

Somente `memory` e `swap` do `.wslconfig` são alterados; as outras escolhas,
comentários, BOM e finais de linha são preservados. Valores existentes são
mostrados na prévia. Seções/chaves duplicadas e codificações não suportadas
são recusadas. As escolhas ficam em `profile.json`, separado das observações.
O efeito fica pendente até o próximo reinício do WSL feito pelo usuário.
Este fluxo não executa `wsl --shutdown` nem reinicia workloads.

## Rust por projeto, builds coordenados por ambiente

```sh
red-dev resources project --project /caminho/reddb --jobs 4
red-dev resources project --project /caminho/reddb --jobs 4 --apply
red-dev resources configure custom --slots 1 --apply
cd /caminho/reddb
red-dev resources run -- cargo check
red-dev resources run -- cargo test -- --test-threads=2
```

A seleção do projeto fica em `.red-dev/resources.json`, junto ao `Cargo.toml`.
Ela fornece `CARGO_BUILD_JOBS` somente ao comando iniciado por esse runner.
Um `-j`/`--jobs` explícito ou `CARGO_BUILD_JOBS` no ambiente tem precedência.
Cargo direto e rust-analyzer mantêm suas próprias configurações. Red-dev não
escreve defaults globais em `~/.cargo/config.toml` nem muda os perfis do RedDB.

O número de slots é compartilhado pelos comandos participantes de todos os
projetos do mesmo ambiente de usuário. As filas Windows e Ubuntu/WSL são
independentes: configure e execute os builds Linux dentro do WSL. O processo
em espera pode ser cancelado com Ctrl+C; ele ainda não iniciou o Cargo.
Diminuir slots não termina builds em andamento. No Linux, um grupo de
processos ainda vivo continua ocupando o slot mesmo se o runner morrer.
Identidade desconhecida ou uma interrupção durante o lançamento conserva o
slot para não admitir trabalho extra sem evidência. Jobs/slots controlam
concorrência, não são uma garantia de consumo máximo de RAM.

## Restaurar

```sh
red-dev resources undo
red-dev resources undo --apply
red-dev resources undo --project /caminho/reddb --apply
red-dev resources configure system --apply
```

`undo` restaura a última alteração desse fluxo no ambiente onde foi aplicada;
há um histórico separado por projeto. Os backups guardam bytes e permissões
anteriores em arquivos privados sob o estado do red-dev. A restauração recusa
sobrescrever arquivos modificados depois por outro dono. Alterações
interrompidas mantêm evidências para restauração e repetição segura.

`system` desativa a coordenação no perfil e restaura o `.wslconfig` anterior
às escolhas explícitas deste fluxo, quando há histórico e o arquivo ainda
corresponde à alteração registrada. Configurações pessoais sem histórico
continuam pertencendo ao usuário. Configurações do projeto têm seu próprio
undo. A restauração de WSL também fica pendente até seu próximo reinício.
