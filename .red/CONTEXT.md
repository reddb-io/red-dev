# Contexto — red-dev

Glossário do domínio. Termos resolvidos em sessões de grilling; livre de detalhes de implementação.

## Perfil

Declaração versionada de intenção de máquina: o conjunto de itens que uma instalação deve convergir. O mecanismo de perfis é neutro; o gosto (quais itens) mora em cada perfil, não no core.

## reddb-employee

O único perfil com usuário conhecido e critério de pronto cobrável. Baseline em camadas: um núcleo **obrigatório** (stack RedDB completo — `red`, `tq`, red-request, `dit`, red-ui, RedSkills — mais Docker, runtimes mise e um agent host padrão), e todo item adicional do catálogo marcado explicitamente como **recomendado** ou **experimental**.

## Camadas de obrigatoriedade

Todo item de um perfil pertence a exatamente uma camada: **obrigatório** (readiness cobra 100%), **recomendado** (instalado por padrão, pode ser recusado) ou **experimental** (opt-in, nunca conta contra o readiness).

## Agent host

Programa cliente de agentes que consome RedSkills numa máquina provisionada. Conjunto suportado decidido: Claude Code, Codex, OpenCode, Gemini, Pi e Hermes — os seis com skills compartilhadas e verificação no doctor. Hermes depende de suporte oficial no RedSkills upstream.

## Readiness report

Resultado que encerra uma convergência de perfil. Distingue por item: `healthy`, `auth-required` (ação humana pendente, não é falha), `unsupported-with-reason`, `failed` e `not-chosen`. "Pronto" = 100% dos obrigatórios em `healthy` ou `auth-required`.
