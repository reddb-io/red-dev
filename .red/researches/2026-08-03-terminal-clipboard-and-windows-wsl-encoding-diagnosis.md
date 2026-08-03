# Diagnóstico de Clipboard e Encoding — Alacritty, Zellij, Herdr, Windows e WSL

**Data:** 2026-08-03

**Escopo:** investigar a cadeia real de copiar, colar e interromper em Alacritty → WSL 2 → Zellij → Herdr, e separar esse problema dos conflitos de encoding entre processos Windows e programas Linux/Bun dentro do WSL.

**Método:** configuração efetivamente implantada, versões e ambiente em execução; documentação oficial; código-fonte pinado do Zellij; documentação e changelog do Herdr; inspeção de bytes; medições de latência; testes focados do repositório.

## Conclusão executiva

Não existe uma incompatibilidade estrutural que torne Alacritty, Zellij e Herdr incapazes de compartilhar o clipboard. A composição é suportável, mas tem **três donos possíveis da seleção** e um bridge Windows com requisitos de tempo e encoding que precisam ser explícitos.

O defeito principal reproduzido foi este:

1. Zellij entrega a seleção como UTF-8 no `stdin` de `copy_command`.
2. A configuração anterior iniciava Windows PowerShell 5.1 para decodificar esse UTF-8 e chamar `Set-Clipboard`.
3. O código do Zellij mata o processo de cópia que ainda estiver vivo depois de um segundo.
4. Nesta máquina, o PowerShell levou entre **1.142 e 1.421 ms** mesmo sem a escrita final no clipboard.
5. Portanto, Zellij mostrava que a seleção tinha sido copiada, mas matava o bridge antes de ele terminar; o clipboard permanecia com o conteúdo antigo.

Esse mesmo defeito atingia seleções feitas dentro do Herdr. O Herdr emite OSC 52; o Zellij externo interpreta esse pedido e o encaminha para o seu próprio provider, que era exatamente o `copy_command` lento. Não são dois bugs independentes.

O bridge ainda mais antigo, `copy_command "clip.exe"`, era rápido, mas recebia bytes UTF-8 onde `clip.exe` não os preservava corretamente. Acentos e emoji viravam mojibake. O caminho tecnicamente correto sob WSL é:

```text
seleção UTF-8 → iconv UTF-8/UTF-16LE sem BOM → clip.exe → clipboard Unicode do Windows
```

O bridge novo completou 20 de 20 execuções em **74–132 ms**, média de **95,9 ms**, bem abaixo do limite do Zellij.

A segunda conclusão importante é que não existe um único “Windows usa UTF-16, WSL usa UTF-8”. Nesta mesma máquina foram observados:

- UTF-8 no locale e na saída dos processos Linux do WSL;
- UTF-16LE na saída redirecionada de comandos próprios do `wsl.exe`;
- CP850 na saída padrão do `cmd.exe` e do Windows PowerShell 5.1;
- UTF-16LE quando `cmd.exe` recebe `/u`;
- UTF-16LE na entrada Base64 de `powershell.exe -EncodedCommand`;
- UTF-8 no `stdin` que o Zellij fornece ao `copy_command`;
- UTF-16LE sem BOM no bridge comprovadamente aceito por `clip.exe` nesta máquina.

Logo, o conserto durável é declarar o encoding **por produtor e por canal**, não aplicar uma heurística genérica a toda saída Windows.

## Contrato correto de teclas

A correção de requisito feita durante a investigação está certa:

- `Ctrl+C` é interrupção/cancelamento e deve chegar ao programa dentro do pane.
- `Ctrl+Shift+C` é cópia da seleção que pertence ao Alacritty.
- arrastar o mouse normalmente deve selecionar e copiar no multiplexer que possui o mouse naquele momento.
- `Ctrl+V` e `Ctrl+Shift+V` colam o clipboard do Windows pelo Alacritty.

O próprio guia do Herdr usa `Ctrl+C` como exemplo de tecla que deve continuar pertencendo ao programa no pane. O prefixo, por padrão `Ctrl+B`, existe para o multiplexer não roubar esses controles.

## Topologia realmente observada

```text
Windows clipboard
       ▲
       │ Copy/Paste nativo; save_to_clipboard
Windows Alacritty
       │
       │ ConPTY / wsl.exe
       ▼
Ubuntu 24.04 no WSL 2
       │
       ▼
Zellij 0.44.3, mouse_mode=true, copy_on_select=true
       │
       ▼
Herdr 0.7.5, mouse_capture=true e copy_on_select=true por padrão
       │
       ▼
shell, editor ou agente — incluindo Codex
```

Ambiente observado:

| Componente | Estado observado |
|---|---|
| Host | Windows, Alacritty nativo |
| Guest | Ubuntu 24.04, WSL 2 |
| Kernel | `6.18.33.2-microsoft-standard-WSL2` |
| Zellij | `0.44.3` |
| Herdr | `0.7.5` |
| Locale Linux | `C.UTF-8` em todas as categorias |
| WSL interop | registrado e funcional; executáveis `.exe` acessíveis |
| Config Zellij | `/mnt/c/Users/filip/.reddev/config/zellij/config.kdl` |
| Config Alacritty | `%APPDATA%\alacritty` no host |
| Config Herdr | `~/.config/herdr/config.toml` |

O locale Linux já é UTF-8. Trocar `LANG` ou `LC_ALL` não corrige os bytes que um executável Windows decidiu escrever no pipe.

## Quem possui cada gesto

| Gesto | Dono | Caminho | Resultado esperado |
|---|---|---|---|
| `Ctrl+C` em modo terminal normal | programa no pane | Alacritty → Zellij locked → Herdr terminal → processo | SIGINT/cancelamento |
| `Ctrl+Shift+C` com seleção do Alacritty | Alacritty | seleção do terminal → clipboard Windows | copia |
| `Ctrl+Shift+C` depois de uma seleção que pertence ao Herdr | Alacritty | não há seleção externa para copiar | pode parecer não fazer nada; a seleção interna já deveria ter autocopiado |
| arrastar normalmente dentro do Herdr | Herdr | seleção → OSC 52 → Zellij → provider de clipboard | copia ao soltar |
| `Ctrl+B`, depois `[`; selecionar; `y`/Enter | Herdr | copy mode → OSC 52 → Zellij → provider | copia scrollback |
| arrastar num pane sem app interno capturando mouse | Zellij | seleção Zellij → `copy_command` | copia ao soltar |
| `Shift` + arrastar | Alacritty | bypass temporário do mouse reporting → seleção externa | copia diretamente por `save_to_clipboard=true` |
| `Ctrl+V` | Alacritty | lê clipboard Windows e injeta texto/paste bracketed | cola texto |
| `Ctrl+Shift+V` | Alacritty | mesmo caminho de Paste | cola texto |

O detalhe que explica grande parte da sensação de aleatoriedade é simples: `Ctrl+Shift+C` só consegue copiar uma seleção que o **Alacritty** conhece. Quando o Herdr desenha a seleção, o Alacritty não tem uma seleção própria. Nesse caso a cópia acontece — ou falha — pelo OSC 52 emitido pelo Herdr.

O Zellij documenta que `mouse_mode` pode interferir com seleção de terminal e recomenda Shift para contornar temporariamente o mouse reporting. O Alacritty documenta `save_to_clipboard=true` como cópia automática do texto selecionado.

## Auditoria das configurações de teclas

### Alacritty

A configuração efetiva importa `theme.toml`, `font.toml`, `shell.toml` e `keys.toml`.

Bindings observados:

```toml
Ctrl+V       -> Paste
Ctrl+Shift+V -> Paste
Ctrl+Shift+C -> Copy
F11          -> ToggleFullscreen
```

Também está ativo:

```toml
[selection]
save_to_clipboard = true
```

Não há binding de `Ctrl+C` no Alacritty. Ele segue para a aplicação, como desejado.

### Zellij

O config efetivo:

- inicia em `default_mode "locked"`;
- usa `keybinds clear-defaults=true`;
- em locked mode só captura `Ctrl+G` para desbloquear;
- mantém `mouse_mode true` e `copy_on_select true`;
- não captura `Ctrl+V` nem `Ctrl+Shift+V` em locked mode;
- usa `Ctrl+C` apenas dentro dos modos próprios de scroll, busca e rename para sair desses modos.

Logo, em uso terminal normal não há colisão Zellij × `Ctrl+C`/`Ctrl+V`.

### Herdr

A configuração local não sobrescreve os defaults relevantes. Na versão 0.7.5:

- `keys.prefix` é `Ctrl+B` por padrão;
- `ui.mouse_capture` é `true` por padrão;
- `ui.copy_on_select` é `true` por padrão;
- copy mode é `prefix+[`;
- `Ctrl+C` continua sendo enviado ao programa do pane;
- desde a correção documentada no changelog, um cliente **local** não usa `Ctrl+V` como paste de imagem e preserva o comportamento da aplicação.

### Única colisão de tecla encontrada

`keys.remote_image_paste` do Herdr é `Ctrl+V` por padrão e só se aplica ao cliente local de `herdr --remote`. O Alacritty captura `Ctrl+V` antes e o transforma em paste textual; nesse cenário específico o Herdr nunca recebe o chord cru para enviar uma imagem remota.

Isso não quebra colar texto local. É uma incompatibilidade condicional para **colar imagem em sessão Herdr remota**. Se esse recurso entrar no contrato do red-dev, a tecla deve ser reconfigurada para um chord que o terminal externo não consuma.

## Caminho de cópia interno Herdr → Zellij

O changelog oficial do Herdr registra que:

- pedidos OSC 52 emitidos por aplicações dentro dos panes são encaminhados ao clipboard do host;
- sob WSL o Herdr passou a preferir OSC 52;
- mouse selection/double-click e copy mode escrevem no clipboard;
- copy mode vive em `prefix+[`;
- clientes locais deixaram de tratar `Ctrl+V` como paste de imagem.

Os logs desta sessão repetiram a mensagem `copied selection to clipboard`. O binário contém os caminhos de escrita OSC 52 e suas mensagens de erro. Isso confirma que o Herdr não tenta iniciar PowerShell para a seleção interna; ele pede ao terminal externo que copie.

O código pinado do Zellij mostra dois providers:

```text
ClipboardProvider::Command(copy_command)
ClipboardProvider::Osc52(clipboard)
```

Quando há `copy_command`, o conteúdo é escrito em bytes UTF-8 no `stdin` do processo. O processo é acompanhado em uma thread; se não terminar em um segundo, é morto e o Zellij registra `Copy operation times out after 1 second`.

O Zellij também interpreta atualizações de clipboard vindas do pane. Portanto, em uma composição aninhada:

```text
Herdr seleciona
  → Herdr emite OSC 52
  → Zellij drena a atualização OSC 52 do pane
  → Zellij chama seu ClipboardProvider
  → provider chama copy_command
```

Essa é a razão de uma mensagem “copiado” do Herdr não provar que o clipboard Windows foi atualizado: a confirmação visual ocorre antes do subprocesso ser eventualmente morto pelo Zellij.

## Reprodução e medições do defeito

### Hipóteses ordenadas

| Ordem | Hipótese | Resultado |
|---|---|---|
| 1 | PowerShell excede o deadline do Zellij | confirmada e causal |
| 2 | bytes UTF-8 entregues diretamente a `clip.exe` sofrem decode errado | confirmada para o bridge antigo |
| 3 | Zellij bloqueia o OSC 52 produzido pelo Herdr | rejeitada; ele o interpreta e encaminha |
| 4 | Herdr captura `Ctrl+C` ou `Ctrl+V` localmente | rejeitada em modo terminal local na 0.7.5 |
| 5 | Zellij locked mode captura os chords | rejeitada pela configuração efetiva |
| 6 | locale do WSL não é UTF-8 | rejeitada; todo o locale é `C.UTF-8` |

### PowerShell antigo

O script de bridge anterior foi exercitado sem a chamada mutante `Set-Clipboard`, para medir apenas startup, leitura e decode:

| Execução | Resultado com limite de 1 s |
|---|---|
| 1–5 | timeout em todas, aproximadamente 1.012 ms |

Sem o limite:

| Execução | Tempo |
|---|---:|
| 1 | 1.142 ms |
| 2 | 1.178 ms |
| 3 | 1.421 ms |

Como o limite no código-fonte do Zellij é exatamente um segundo, a causa não depende de conjectura.

### Bridge novo

O bridge `iconv | clip.exe` foi exercitado 20 vezes:

| Métrica | Valor |
|---|---:|
| Sucessos | 20/20 |
| Mínimo | 74 ms |
| Máximo | 132 ms |
| Média | 95,9 ms |

O teste automatizado usa um `clip.exe` falso e verifica que `copiar e colar: ação — 🧪` chega como UTF-16LE sem BOM em menos de um segundo. Esse teste não depende do clipboard real.

### Estado presente no worktree durante a auditoria

Outro fluxo de trabalho alterou estes arquivos enquanto o diagnóstico estava em andamento; estas mudanças não foram produzidas por este relatório:

- `config/bash/windows-clipboard.sh`;
- `src/dotfiles.ts`;
- `src/clipboard.test.ts`;
- `src/windows-output.ts` e teste;
- `src/alacritty.ts`;
- `src/wsl-provision.ts`, `src/wsl-sync.ts` e testes relacionados.

O config implantado passou a conter:

```kdl
copy_command "bash /home/cyber/.local/share/red-dev/config/bash/windows-clipboard.sh"
```

O helper implantado é idêntico ao helper do repositório e é invocado explicitamente por `bash`, portanto o modo de arquivo `0644` não é um problema.

Isso valida a direção da correção, mas não prova rollout completo:

- o worktree ainda está sujo e sem evidência de commit/merge neste diagnóstico;
- a sessão Zellij atual é mais antiga que a alteração do arquivo;
- um arquivo alterado em disco não prova que o processo já recarregou a opção;
- a validação final deve ocorrer em uma sessão nova ou depois de um reload explicitamente comprovado.

## Charset: o que realmente está acontecendo

### Evidência em bytes

Texto de prova: `ação`.

| Produtor | Configuração | Bytes observados | Decode correto |
|---|---|---|---|
| processo Linux no WSL | locale `C.UTF-8` | `61 c3 a7 c3 a3 6f` | UTF-8 |
| `wsl.exe -l -v` redirecionado | padrão do launcher | pares como `20 00 4e 00 ...` | UTF-16LE |
| `cmd.exe /c echo ação` | code page 850 | `61 87 c6 6f 0d 0a` | CP850/OEM atual |
| `cmd.exe /u /c echo ação` | `/u` | `61 00 e7 00 e3 00 6f 00` | UTF-16LE |
| Windows PowerShell 5.1 | output padrão observado | `61 87 c6 6f 0d 0a` | CP850/OEM atual |
| PowerShell 5.1 com `Console.OutputEncoding=UTF8` | output normalizado | `61 c3 a7 c3 a3 6f` | UTF-8 |

Na sessão observada, Windows PowerShell 5.1 reportou:

| Propriedade | Valor |
|---|---|
| `Console.InputEncoding` | `ibm850` |
| `Console.OutputEncoding` | `ibm850` |
| `$OutputEncoding` | `us-ascii` |
| `[Text.Encoding]::Default` | Windows-1252 |
| `chcp` | 850 |

Decodificar o output CP850 com `new Response(proc.stdout).text()` — que assume UTF-8 — produziu `a��o`.

### Por que não é “UTF-16 versus UTF-8” apenas

Há pelo menos quatro decisões distintas:

1. encoding do texto do comando passado ao PowerShell;
2. encoding do `stdin` recebido pelo processo filho;
3. encoding do `stdout`/`stderr` produzido pelo executável;
4. formato armazenado no clipboard ou no arquivo.

`powershell.exe -EncodedCommand` exige Base64 de uma string UTF-16LE. Isso descreve a **entrada do comando**, não garante que o stdout será UTF-16LE.

`$OutputEncoding` controla como PowerShell envia texto para programas nativos. `[Console]::OutputEncoding` controla como a aplicação escreve para a saída do console. Nenhuma dessas propriedades conserta automaticamente os bytes que `wsl.exe` ou `cmd.exe` escolheram emitir.

`chcp 65001` também não é uma política suficiente: depende de console, processo, versão e modo de redirecionamento; não muda o contrato particular de `wsl.exe`, nem o requisito UTF-16LE de `-EncodedCommand`.

### O clipboard é outro canal

O Windows possui formatos de clipboard como `CF_TEXT`, `CF_OEMTEXT` e `CF_UNICODETEXT`, e pode sintetizar conversões entre eles. O comando `clip` recebe bytes redirecionados e os coloca no clipboard, mas sua documentação não promete que bytes UTF-8 arbitrários serão interpretados como UTF-8.

Por isso, o bridge não deve depender da code page ativa. A conversão explícita de UTF-8 para UTF-16LE, validada com acentos, travessão e emoji, torna o contrato determinístico nesta fronteira.

## Auditoria de fronteiras Windows no código

### Já tratadas pelas mudanças presentes

| Local | Produtor | Situação |
|---|---|---|
| `src/wsl-provision.ts` | `wsl.exe -l -v/-q` | usa `readWindowsOutput`; cobre UTF-16LE redirecionado |
| `src/wsl-sync.ts` | `wsl.exe -d ...` | usa `readWindowsOutput`; cobre stdout UTF-8 do distro e erro UTF-16LE do launcher |
| `src/alacritty.ts`, `defaultWslDistro` | `wsl.exe -l -q` | usa `readWindowsOutput` |
| `src/alacritty.ts`, leitura/escrita de arquivos | PowerShell → Base64 ASCII | seguro para conteúdo arbitrário; bytes do arquivo continuam UTF-8 |
| `src/dotfiles.ts` + helper | Zellij UTF-8 → `clip.exe` | conversão explícita UTF-16LE e deadline atendido |

### Ainda frágeis para texto não ASCII

| Prioridade | Local | Problema | Impacto provável |
|---|---|---|---|
| alta | `src/alacritty.ts:25-29`, `105-133` | `cmd.exe /c echo %APPDATA%` decodificado como UTF-8 | perfil Windows com acento pode impedir localizar/configurar Alacritty |
| alta | `src/wsl.ts:44-49`, `75`, `100` | `%LOCALAPPDATA%` e `%USERPROFILE%` por `cmd.exe /c` + UTF-8 ingênuo | nomes de usuário e perfis redirecionados com acento corrompem paths |
| alta | `src/theme-editors.ts:96-105` | `%APPDATA%` por `cmd.exe /c` + UTF-8 ingênuo | tema do VS Code não encontra `settings.json` |
| alta | `src/wallpaper.ts:186-220` | caminho de wallpaper sai do PowerShell sem encoding declarado | wallpaper com diretório/nome acentuado vira path inválido |
| média | `src/hotkeys.ts:117-131` | stdout e stderr do PowerShell decodificados como UTF-8 | labels, targets ou erros localizados aparecem corrompidos |
| média | `src/providers.ts:200-230` | saída do Winget via `cmd.exe` decodificada como UTF-8 | detecção por mensagem e diagnóstico quebram em Windows localizado |
| baixa | `src/drift.ts:284-300` | nome de família retornado pelo PowerShell sem encoding declarado | fontes futuras com nome não ASCII podem aparecer corrompidas |
| baixa | `src/migrations.ts:56-73`, `101-115` | retorno atual é numérico ASCII | caminho feliz é seguro, mas o padrão não documenta o contrato |

### ASCII seguro, mas stderr ainda merece contrato

Estes caminhos retornam tokens controlados como `yes/no`, `added/present`, `ok` ou Base64 e não corrompem o dado principal:

- `hostFileExists` e `readThroughHost` em `src/alacritty.ts`;
- `addWindowsBinToPath` em `src/shared-root.ts`;
- `applyWindowsTheme` em `src/windows-theme.ts`.

Porém, quando o stderr de PowerShell contém uma mensagem localizada, o decode UTF-8 ingênuo ainda pode destruir justamente o diagnóstico apresentado ao usuário.

## Limite do decoder heurístico atual

`src/windows-output.ts` detecta:

- BOM UTF-16LE;
- texto ASCII-heavy em UTF-16LE pela distribuição dos NULs;
- caso contrário, UTF-8.

Isso é apropriado para o comportamento misto de `wsl.exe`: sucesso de um processo Linux pode ser UTF-8, enquanto erro do launcher pode vir em UTF-16LE.

Não é um decoder universal de “saída Windows”:

- CP850 não possui NULs e será confundido com UTF-8;
- a página OEM varia por máquina e idioma;
- texto UTF-16LE majoritariamente não ASCII pode ter poucos NULs e escapar da heurística;
- UTF-16BE não é tratado;
- heurística não substitui um contrato conhecido do produtor.

O nome `readWindowsOutput` sugere uma generalidade que a implementação não deve ganhar. Ele deve permanecer restrito ao boundary misto do `wsl.exe`, ou ser renomeado para tornar essa limitação impossível de esquecer.

## Arquitetura recomendada

Em vez de um `capture()` que sempre chama `Response.text()`, cada spawn Windows deveria declarar o contrato:

```ts
type ProducerEncoding =
  | "utf8"
  | "utf16le"
  | "wsl-mixed"
  | "ascii"
  | "base64-ascii";
```

Helpers recomendados:

| Helper conceitual | Uso |
|---|---|
| `captureUtf8(argv)` | produtor explicitamente normalizado para UTF-8 |
| `captureUtf16Le(argv)` | `cmd.exe /u` e outros produtores com contrato UTF-16LE |
| `captureWslMixed(argv)` | apenas `wsl.exe`, onde child stdout e launcher error diferem |
| `capturePowerShellUtf8(script)` | prefixa `[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)` |
| `captureBase64(argv)` | paths e conteúdo arbitrário devolvidos como Base64 ASCII |

Regras por produtor:

1. **`cmd.exe`:** para valores de ambiente e paths, usar `/d /u /c` e decodificar explicitamente UTF-16LE; `/d` evita AutoRun do usuário contaminando a saída.
2. **Windows PowerShell 5.1:** normalizar `[Console]::OutputEncoding` para UTF-8 sem BOM no próprio script, ou retornar Base64/JSON ASCII quando o conteúdo for arbitrário.
3. **`wsl.exe`:** manter leitura de bytes e decode misto, coberto por fixtures de sucesso UTF-8 e erro/listagem UTF-16LE.
4. **Arquivos:** transferir bytes em Base64 quando cruzar PowerShell/WSL; não transportar TOML/JSON multiline diretamente por quoting de shell.
5. **Clipboard:** Zellij UTF-8 → UTF-16LE sem BOM → `clip.exe`, sempre com teste de latência abaixo de 1 s.
6. **stderr:** aplicar o mesmo contrato do produtor; não corrigir apenas stdout.

## Testes de aceitação necessários

### Clipboard

- texto ASCII;
- `ação, configuração, São Paulo`;
- travessão e aspas tipográficas;
- CJK;
- emoji fora do BMP, por exemplo `🧪`;
- múltiplas linhas;
- payload vazio;
- payload grande o bastante para expor bloqueio de pipe;
- 20–50 repetições, todas abaixo de 1 s com margem;
- WSL interop ausente deve falhar de forma explícita;
- `iconv` ausente deve falhar de forma explícita.

### Gestos

- `Ctrl+C` interrompe processo no shell dentro de Herdr dentro de Zellij;
- seleção normal do mouse no Herdr atualiza clipboard Windows;
- copy mode do Herdr atualiza clipboard Windows;
- seleção própria do Zellij atualiza clipboard Windows;
- `Shift` + drag cria seleção externa do Alacritty e copia;
- `Ctrl+Shift+C` copia seleção externa;
- `Ctrl+V` e `Ctrl+Shift+V` colam uma vez, com multiline como bracketed paste;
- o caso `herdr --remote` documenta ou reconfigura paste de imagem.

### Paths e stdout Windows

Usar fixtures e, em CI Windows/WSL, perfis contendo:

- `C:\Users\João`;
- `C:\Dados\Configuração`;
- wallpaper `São Paulo — noite.png`;
- output em CP850;
- output UTF-8;
- output UTF-16LE com e sem BOM;
- erro localizado em stderr;
- listagem do WSL com nome de distribuição não ASCII.

## Critérios de conclusão para o conserto

O problema só deve ser considerado resolvido quando:

1. o config implantado usa o bridge rápido;
2. a sessão Zellij efetivamente em execução foi reiniciada/recarregada e isso foi reobservado;
3. mouse selection no Herdr e copy mode atualizam o clipboard Windows com texto Unicode;
4. `Ctrl+C` continua interrompendo;
5. `Ctrl+Shift+C`, `Ctrl+V` e `Ctrl+Shift+V` obedecem ao contrato acima;
6. todos os testes focados passam;
7. os paths `%APPDATA%`, `%LOCALAPPDATA%` e `%USERPROFILE%` não dependem de decode CP850 como UTF-8;
8. os boundaries restantes de PowerShell/cmd têm encoding declarado;
9. a mudança está commitada, integrada e validada numa sessão nova — não apenas presente num worktree sujo.

## Validação automatizada observada

Com as mudanças concorrentes presentes, o comando focado passou:

```text
bun test src/clipboard.test.ts src/windows-output.test.ts src/wsl-provision.test.ts

22 pass
0 fail
33 expect()
```

O teste de clipboard usa um executável falso e não toca o clipboard real.

Não foi possível abrir uma segunda instância Herdr totalmente isolada dentro da sessão Herdr já ativa: o produto bloqueia nested launch por padrão e o processo continuou encontrando o namespace existente mesmo com variáveis removidas. Forçar ou parar a sessão real destruiria trabalho em andamento, então o seam completo de paste não foi exercitado. A sessão Zellij diagnóstica criada para essa tentativa foi encerrada ao final.

Durante um probe anterior do bridge, o clipboard real foi sobrescrito por texto ASCII e o conteúdo anterior não pôde ser recuperado. Depois desse incidente todos os testes foram movidos para doubles/fakes e nenhum outro probe alterou o clipboard real.

## Fontes oficiais

### Alacritty

- [Configuração oficial do Alacritty](https://alacritty.org/config-alacritty.html) — `save_to_clipboard`, ações `Copy` e `Paste`.

### Zellij

- [Zellij options](https://zellij.dev/documentation/options.html) — `mouse_mode`, `copy_command`, `copy_on_select` e fallback OSC 52.
- [Clipboard provider no código pinado](https://github.com/zellij-org/zellij/blob/a7259350a835dd89e89ce26dc88f2e31f2f38f6f/zellij-server/src/tab/clipboard.rs) — provider Command versus OSC 52.
- [Implementação pinada de copy_command](https://github.com/zellij-org/zellij/blob/a7259350a835dd89e89ce26dc88f2e31f2f38f6f/zellij-server/src/tab/copy_command.rs) — bytes escritos no stdin e timeout de um segundo.
- [Tratamento de output/OSC no tab do Zellij](https://github.com/zellij-org/zellij/blob/a7259350a835dd89e89ce26dc88f2e31f2f38f6f/zellij-server/src/tab/mod.rs) — atualização de clipboard emitida por pane aninhado.

### Herdr

- [Herdr keyboard](https://herdr.dev/docs/keyboard/) — `Ctrl+C` pertence ao programa, prefixo, copy mode e mouse drag-select.
- [Herdr config reference](https://herdr.dev/docs/config-reference/) — defaults de `prefix`, `remote_image_paste`, `mouse_capture` e `copy_on_select`.
- [Herdr changelog](https://github.com/herdrdev/herdr/blob/master/CHANGELOG.md) — OSC 52 aninhado, WSL clipboard, copy mode, bracketed paste e correção do `Ctrl+V` local.

### Windows e PowerShell

- [PowerShell about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding?view=powershell-7.6) — inconsistências históricas do Windows PowerShell e papel de `$OutputEncoding`.
- [PowerShell 5.1 executable](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1) — `-EncodedCommand` exige UTF-16LE antes de Base64.
- [.NET Console.OutputEncoding](https://learn.microsoft.com/en-us/dotnet/api/system.console.outputencoding) — encoding usado para escrever output do console.
- [`cmd.exe`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd) — `/u` produz output Unicode e `/d` desativa AutoRun.
- [`clip`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/clip) — entrada redirecionada para o clipboard.
- [Formatos do clipboard Win32](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats) — `CF_TEXT`, `CF_OEMTEXT`, `CF_UNICODETEXT` e conversões do sistema.

## Decisão recomendada

Manter a composição Alacritty + Zellij + Herdr. Ela não precisa ser removida para obter clipboard confiável.

Padronizar a experiência assim:

```text
Ctrl+C                interrupção
Ctrl+Shift+C          cópia de seleção do Alacritty
mouse drag            seleção/cópia do Herdr ou Zellij
Shift+mouse drag      seleção/cópia externa do Alacritty
Ctrl+V                paste do clipboard Windows
Ctrl+Shift+V          paste alternativo do clipboard Windows
Ctrl+B [ ... y        copy mode do Herdr
```

Completar o trabalho em duas trilhas separadas:

1. **Clipboard:** integrar e validar o helper rápido numa sessão Zellij nova, incluindo Unicode e os gestos acima.
2. **Encoding:** substituir captures genéricos nos boundaries Windows por contratos explícitos, começando pelos paths de `%APPDATA%`, `%LOCALAPPDATA%` e `%USERPROFILE%`.

Essa separação evita a correção cosmética de trocar locale ou code page global, que pode mascarar um produtor e quebrar outro.
