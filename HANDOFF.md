# Handoff — Plugin `usage-bar` (barra de status da TUI do opencode)

**Data:** 03/10/2026
**Ambiente:** Windows · opencode v2.0.22 (npm) · tema `orng`
**Autor da sessão anterior:** agente + Lucas

---

## 1. Objetivo

Barra de status no rodapé do prompt (abaixo do input), com:

- **Esquerda:** pasta · branch git (se houver) · **% oficial do plano mensal da Go**
- **Direita:** tokens de contexto (com %) · diff git `(+add -del)` · custo da sessão `$`
- Tudo em **cinza** (tokens do tema), sem barra de progresso, sem ícones

Layout esperado:

```
~/projeto  git:main  81%          ctrl+p commands          297.0K (30%)  (+0 -0)  $0.18
```

---

## 2. Arquivos

| Caminho | Papel |
| --- | --- |
| `C:\Users\Lucas\.config\opencode\plugins\usage-bar\tui.tsx` | **O plugin** (todo o código da TUI) |
| `...\usage-bar\index.ts` | Entrada de servidor (no-op; necessária para a descoberta do plugin) |
| `...\usage-bar\config.json` | Configuração do plugin |
| `...\usage-bar\console.key` | Chave de serviço do Console (1 linha) — **segredo**. Pode ser substituída pela env `USAGE_BAR_CONSOLE_KEY` (preferida) |
| `...\usage-bar\node_modules\` | `@opencode/plugin@2.0.22` instalado (resolve o import do `index.ts`) |
| `C:\Users\Lucas\.config\opencode\cli.json` | Desativa o rodapé padrão (`-opencode.prompt.footer`) para não duplicar contexto/custo |
| `C:\Users\Lucas\.config\opencode\opencode.json` | Plugin `opencode-status-popup` (tray) — não relacionado |

---

## 3. Como funciona (fontes de dados)

Ordem de tentativa (config `source: "auto"`):

1. **Oficial (recomendado):**
   `GET https://opencode.ai/zen/go/v1/usage` com `Authorization: Bearer <console.key>`
   → `usage.monthly.percent` + `usage.monthly.resetsAt` (e também `rolling`/`weekly`).
   Os valores batem com a página do Console (validado: 3–5% / 47% / 81%). Buscado **mesmo sem modelo selecionado**; se a API falhar, o fallback aparece com `~` (aproximado).
2. **Console (fallback):**
   `GET https://opencode.ai/console/api/usage/models?range=30d`
   → custo por modelo em microcents (÷ 1e8) ÷ limite mensal do modelo (tabelas `GO_LIMITS` / `GO_PLUS_LIMITS` embutidas no código).
3. **Local (fallback):**
   `client.session.stats` (endpoint experimental do servidor local), com ciclo configurável (`billing`/`calendar`/`rolling`).

Demais itens:

- **Pasta:** `ctx.ui.format.path(session.location.directory)` (encurta para as 2 últimas pastas se passar de 34 chars)
- **Branch:** `ctx.data.location.vcs.info(loc)?.branch?.current` (+ `vcs.sync` ao mudar de pasta)
- **Contexto:** última mensagem do assistente com `tokens` = input + output + reasoning + cache.read + cache.write, dividido por `limit.context` do modelo
- **Diff:** `client.vcs.status({ location: { directory } })`, somando `additions`/`deletions`
- **Custo:** `ctx.data.session.cost(sessionID)` — quando é a raiz, soma a **família inteira** (sessão + subagentes); em sessão filha, só o próprio

Slots usados no `prompt.footer`:

- `prepend` → grupo da esquerda (part `"plan"`)
- `append` → grupo da direita (part `"rest"`)

---

## 4. Configuração (`config.json`)

| chave | valores | descrição |
| --- | --- | --- |
| `plan` | `go` \| `go_plus` | Usado só nos fallbacks (tabela de limites) |
| `source` | `auto` \| `official` \| `console` \| `local` | Fonte do % do plano |
| `consoleRange` | `24h` \| `7d` \| `30d` \| `all` | Janela do fallback Console |
| `cycle` | `{ mode: "billing"\|"calendar"\|"rolling", day }` | Só na fonte local (dia 14) |
| `refreshSeconds` | número | Intervalo de atualização (60s; mínimo 10) |
| `percentBias` | número | Soma na exibição do % (1 = acompanha o arredondamento do site; 0 desliga) |
| `show.path/branch/plan/context/diff/cost/reset` | bool | Liga/desliga cada item |

Credencial (ordem de resolução): env `USAGE_BAR_CONSOLE_KEY` → arquivo `console.key` ao lado do plugin → `auth.json` do próprio opencode (provider `opencode-go`, presente em qualquer máquina logada no plano). O `config.json` é validado/normalizado (valores inválidos caem no default).

---

## 5. Descobertas e decisões

- A **API oficial** `/zen/go/v1/usage` foi encontrada escaneando o app do Console (`console.js`) — é o melhor dado (percent + reset exatos).
- A API interna `console/api/internal/orgs/{orgId}/go/status` (meters completos) é **staff-only** → 401 com service key.
- Em `/api/usage/models`, o parâmetro `since` é **travado no início do mês UTC**; `range=30d` (sem `since`) funciona.
- Limites da Go (docs): por modelo; janelas **5h = 20%**, **semana = 50%**, **mês = 100%** do limite mensal. O endpoint oficial devolve % do **plano inteiro** (igual ao Console).
- Reset mensal oficial: **14/10/2026 17:06 UTC** (assinatura renova dia 14). Weekly reseta segunda 00:00 UTC.
- `show.reset: false` por padrão; ligar para exibir `↻ 11d 13h` ao lado do %.
- **Diferença de 1 ponto vs. site:** o site **arredonda** o percentual (83,6% → 84%) e a API pública `/zen/go/v1/usage` **trunca** o inteiro (→ 83). Não há parâmetro com decimais (`detailed`/`full`/`window` são ignorados) e a resposta é `no-store`. Para acompanhar o site, o `config.json` usa `"percentBias": 1` (soma 1 na exibição; trade-off: quando a fração real for < 0,5 o site mostra o mesmo inteiro da API e a barra fica 1 acima — usar 0 para desligar). Única alternativa para valor exato: capturar headers de rate limit das respostas de inferência (não verificado se a Go envia).

---

## 6. Bugs já corrigidos

1. **Erro a cada boot:** `index.ts` importava `@opencode/plugin` sem `node_modules` → instalado `@opencode/plugin@2.0.22` na pasta do plugin (import validado).
2. Duplicidade do contador de contexto/custo: resolvida desativando `opencode.prompt.footer` no `cli.json`.
3. **Custo ignorando subagentes:** o `$` usava `session().cost`, que exclui as sessões filhas. Agora usa `ctx.data.session.cost(sessionID)` — chamado na sessão raiz, ele soma a família inteira (confirmado: raiz com 2 subagentes tinha $0.0407 fora da conta).
4. **Pasta duplicada (`~` à direita do `%`) — causa raiz real:** o rodapé **nativo** do host renderiza `pasta:branch` num `<text id="prompt.footer.location">` dentro de `prompt.footer.status` (bloco nativo, **não** é o plugin `opencode.prompt.footer`; por isso desativá-lo não removeu). Fix em `setup`: esconder o elemento via `context.renderer.root.findDescendantById("prompt.footer.location").visible = false` (o setter chama `yogaNode.setDisplay(NONE)`, removendo do layout), reaplicado a cada 1s porque o host remonta o elemento (hints/troca de sessão). **Confirmado visualmente em 03/10/2026.** (A tentativa anterior com texto único via `createMemo` não era a causa; foi mantida por ordem estável dos itens.)
5. **Endurecimento (sessão de continuação):** validação/normalização do `config.json` (`refreshSeconds` ≥ 10, `source`/`cycle`/`windows`/`limits`/`show`); timeout + `AbortController` nas requisições HTTP (10–15s); `deadline` de 15s nas chamadas locais (`session.stats`, `vcs.status`); uma atualização por vez com **escopo** (sessão/modelo/pasta) — respostas antigas são descartadas e atualizações concorrentes não se sobrepõem; `%` oficial buscado mesmo sem modelo; fallback exibido como `~NN%`; credencial via env `USAGE_BAR_CONSOLE_KEY` (fallback: arquivo).
6. **`percentBias` ignorado (05/10/2026):** o `normalizeConfig` remonta o config campo a campo e **não repassava** o `percentBias` — o valor do `config.json` era descartado e a barra continuava no inteiro truncado da API (83, enquanto o site mostrava 84). Fix: `normalizeConfig` valida/repassa `percentBias` (clamp -100..100). Commit `e0b27b5`. **Confirmado: barra 84 = site 84.**

---

## 7. Comandos de validação

```powershell
# sintaxe do tui.tsx
npx --yes esbuild "C:\Users\Lucas\.config\opencode\plugins\usage-bar\tui.tsx" --loader:.tsx=tsx --format=esm --outfile="$env:TEMP\check.js"

# JSON válido
python -c "import json; json.load(open(r'C:\Users\Lucas\.config\opencode\plugins\usage-bar\config.json', encoding='utf-8'))"

# endpoint oficial (mostra rolling/weekly/monthly)
$key = (Get-Content 'C:\Users\Lucas\.config\opencode\plugins\usage-bar\console.key' -Raw).Trim()
curl.exe -s -H "Authorization: Bearer $key" https://opencode.ai/zen/go/v1/usage

# log do opencode (erros de plugin)
Get-Content 'C:\Users\Lucas\.local\share\opencode\log\opencode.log' -Tail 100 | Select-String 'usage-bar|failed to load'
```

---

## 8. Pendências / próximos passos

1. ~~Reiniciar/reload e confirmar layout.~~ **Confirmado em 03/10/2026:** barra correta, uma única pasta, sem erro no boot.
2. ~~Carregamento explícito no `cli.json`.~~ Não é necessário: `GET /api/plugin` mostra `luccas.usage-bar` ativo com `features: {server, tui}`; log sem WARN/ERROR.
3. Opcional: mostrar também **rolling (5h)** e **weekly** na barra (o endpoint já entrega).
4. Opcional: `"reset": true` no `show` para o countdown oficial.
5. **Segurança:** preferir a env `USAGE_BAR_CONSOLE_KEY` ao arquivo `console.key`; a service key atual tem permissão **All** (gerencia budgets) — revogar/rotacionar no Console quando não precisar; para desligar o uso: `"source": "local"`.

---

## 9. Estado do uso no momento do handoff (05/10/2026)

- **rolling:** 6% (reseta 05/10 17:00 UTC)
- **weekly:** 2% (reseta 12/10 00:00 UTC)
- **monthly:** **83% na API / 84% no site** (reseta 14/10 17:06 UTC) — a barra com `percentBias: 1` exibe **84**

---

## 10. Sessão 06/10/2026 — compact por clique + credencial via auth.json

### 10.1 Compactar pasta/branch por clique (novo)

- **Clique** na pasta/branch cicla níveis: pasta `full → short (última pasta) → initials → alias` (alias só se configurado); branch `full → curta → iniciais → [hidden se main/master]`.
- **alt+clique** volta um nível; **shift+clique** copia o valor completo (OSC 52, `copy: true`); **hover** acende a parte clicável.
- **Keybinds** de fallback: `alt+p` (pasta) e `alt+g` (branch) via `ctx.keymap.layer`.
- **Config novo** (`config.json` → bloco `compact`): `click` (cycle|toggle|off), `alias` (basename case-insensitive → apelido; desempate por caminho completo), `initials` ({from: last|lastTwo|whole, min}), `pathLevels`/`branchLevels`, `hideMainBranch`, `hover`, `copy`, `persist` (session|file; file grava `compact-state.json`), `keybinds` (null desliga).
- Níveis que renderizam o **mesmo texto** são pulados (ex.: `full == short` em caminho curto), então todo clique muda algo visível.
- Descobertas validadas no host (tag `v2.0.23`): (a) o rodapé suporta mouse por design (o próprio `opencode.prompt.footer` usa `<box onMouseUp>`); (b) o mouse-up chega com **`isDragging=true` sempre** — não filtrar por isso (só por `button`); (c) guard de botão aceita `undefined/0/3/"left"`.
- Cliques confirmados visualmente em 06/10/2026 (pasta e branch, com intermediário).
- **Sync entre abas/janelas:** `persist: "file"` grava `compact-state.json` e cada instância observa o arquivo via `fs.watch` — compactar numa aba reflete nas outras. O `config.json` do repo passou a usar `"persist": "file"`.

### 10.2 Credencial da API oficial sem `console.key`

- O opencode guarda a credencial do plano em `~/.local/share/opencode/auth.json` (provider `opencode-go`, `{type:"api", key}`) e ela **funciona** em `/zen/go/v1/usage`.
- O plugin resolve nesta ordem: env `USAGE_BAR_CONSOLE_KEY` → `console.key` → `auth.json` (revalida a cada 5 min).
- Confirmado em 06/10/2026: barra com o % oficial (API 85 + `percentBias: 1` = 86 = site).

_Atualizado em 06/10/2026 (3ª sessão): compact por clique + credencial via auth.json; instrumentação de debug removida. Notas das sessões anteriores mantidas._
