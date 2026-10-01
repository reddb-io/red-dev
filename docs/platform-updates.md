# Atualizações e responsabilidade

O catálogo oferece ferramentas; a política registra quem pode mantê-las.
Isso vale para ferramentas portáveis instaladas pelo mise, agentes CLI com
backend mise e runtimes. Pacotes apt/winget conservam seus mecanismos próprios.

| Política | Comportamento |
| --- | --- |
| `follow` | Acompanha `latest`; instalação e atualização pelo red-dev |
| `fixed` | Instala a versão escolhida; não avança nem limpa versões automaticamente |
| `external` | Retira a declaração gerada; não instala, atualiza ou limpa o pacote |

Uma versão/canal já escolhido na configuração global do mise é preservado
automaticamente. Seleções com múltiplas versões ficam sob responsabilidade
externa. Arquivos inválidos são reportados; não são substituídos por defaults.
Escolher `follow` explicitamente autoriza voltar a `latest` para aquela ferramenta.
Escolher `fixed` explicitamente seleciona a versão via mise. `external` preserva
o pacote existente e os arquivos pessoais: não é uma desinstalação.

```sh
red-dev policy
red-dev policy claude fixed 2.1.283
red-dev policy claude follow
red-dev policy claude external
```

As políticas ficam na seção `policies` de `~/.red/dev/config.yaml`.
O JSON antigo é importado com backup durante instalação/atualização. Alterações explícitas são serializadas com as atualizações. No
Windows com WSL, ferramentas Linux recebem sua política no Ubuntu selecionado;
ferramentas instaladas nos dois lados recebem a escolha nos dois lados.

## Uma execução automática por vez

O agendador do sistema chama `red-dev maintenance`. A entrada coordena três
trabalhos com intervalos próprios: RedSkills, atualização da suíte/agentes e
observação de versões para a interface. Os comandos manuais de atualização e
agentes compartilham a mesma exclusão por ambiente. Um comando manual pode
repetir a tentativa imediatamente, mas não executa em paralelo com outro updater.

Falhas registram uma próxima tentativa com espera crescente, começando perto
de um minuto, até cerca de seis horas, com variação entre máquinas. A última
observação válida é preservada. Uma consulta inválida não significa que todas
as ferramentas estão atualizadas. O updater do red-dev instala a release exata
observada e não apaga o cache global do mise.

`red-dev doctor` mostra a última tentativa, o último sucesso e a próxima
tentativa automática. O estado privado fica em `update-coordinator.json` no
diretório de estado red-dev. Um processo vivo mantém sua exclusão mesmo se
estiver lento. Exclusões deixadas por processos comprovadamente mortos podem
ser recuperadas. Estado de proprietário desconhecido é preservado.

## Migração dos gatilhos

A unidade/tarefa existente de watch passa a chamar o coordenador. O timer
horário separado é retirado com backup. O hook de rede no prompt é retirado;
ao recarregar uma shell aberta, somente sua entrada gerada é removida do prompt.
Chamadas antigas com origem `shell` também ficam inertes antes de acessar a rede.

Backups exatos ficam em `retired-update-triggers` no estado red-dev. A migração
verifica os marcadores de propriedade e pode ser repetida após falhas. Ela
desativa os timers, sem parar os serviços de atualização que já estavam rodando.

O Windows agenda também seu Ubuntu/WSL provisionado; esse Ubuntu registra o
responsável e retira seu agendamento duplicado. Um WSL instalado de forma
independente mantém o agendamento local. Para reassumir explicitamente o
agendamento local de um WSL coordenado, execute a instalação com
`RED_DEV_UPDATE_OWNER=local`. Ubuntu nativo mantém somente sua execução local.

Os controles existentes continuam válidos:

- `RED_DEV_AUTO_UPDATE=0`: desliga atualização automática da suíte/agentes.
- `RED_SKILLS_WATCH=0`: desliga acompanhamento de RedSkills.
- Ambos desligados: desliga o agendamento.
- `RED_DEV_AUTO_UPDATE_MINUTES`: intervalo da suíte, padrão 60 minutos.
- `RED_SKILLS_WATCH_MINUTES`: cadência do agendador/RedSkills, padrão 10 minutos.

Instalação inicial, permissões do sistema e autenticação continuam exigindo suas
etapas próprias. Esta mudança não publica um lock completo da workstation nem
transforma upgrades de pacotes do sistema em transações reversíveis.
