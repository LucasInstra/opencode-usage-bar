// Testes da estimativa de custo do usage-bar.
//   node --test test/cost.test.mjs
//
// Os helpers de preço (tokensCost / promptTokens / pricedCost) são extraídos do
// tui.tsx real, então o teste quebra se a matemática mudar. A composição
// (janela x cauda x agregado) é replicada aqui; os marcadores no fim do arquivo
// falham se a lógica do plugin sair de sincronia com a réplica.

import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(here, "..", "tui.tsx"), "utf8")

// ---------------------------------------------------------------- extração
function extractFunction(name) {
  const start = SOURCE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `função ${name} não encontrada no tui.tsx`)
  let depth = 0
  let i = SOURCE.indexOf("{", start)
  for (; i < SOURCE.length; i++) {
    if (SOURCE[i] === "{") depth++
    else if (SOURCE[i] === "}") {
      depth--
      if (depth === 0) break
    }
  }
  return SOURCE.slice(start, i + 1)
}

// remove anotações de tipo simples dos trechos extraídos (o teste roda JS puro)
function stripTypes(code) {
  return code
    .replace(/\b(\w+)\?:\s*[^,)=\n]+(?=[,)])/g, "$1")
    .replace(/:\s*(?:any|number|string|boolean|null|undefined)(?:\s*\|\s*(?:any|number|string|boolean|null|undefined))*/g, "")
}

const { tokensCost, promptTokens, pricedCost } = new Function(
  [
    stripTypes(extractFunction("tokensCost")),
    stripTypes(extractFunction("promptTokens")),
    stripTypes(extractFunction("pricedCost")),
    "return { tokensCost, promptTokens, pricedCost }",
  ].join("\n"),
)()

// ---------------------------------------------------------------- réplica
const sameModel = (ref, m) => !!ref && !!m && ref.providerID === m.providerID && (ref.id === m.id || ref.id === m.modelID)
const findModel = (models, ref) => models.find((x) => sameModel(ref, x)) ?? null
const totalTokens = (t) =>
  (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0) + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)

function visibleMessages(messages, models) {
  const seen = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
  let cost = 0
  let oldestModel = null
  for (const m of messages) {
    if (m?.type !== "assistant" || !m.tokens) continue
    cost += pricedCost(m.tokens, findModel(models, m.model))
    seen.input += m.tokens.input ?? 0
    seen.output += m.tokens.output ?? 0
    seen.reasoning += m.tokens.reasoning ?? 0
    seen.cache.read += m.tokens.cache?.read ?? 0
    seen.cache.write += m.tokens.cache?.write ?? 0
    if (!oldestModel) oldestModel = m.model
  }
  return { cost, seen, oldestModel }
}

function windowIsComplete(info, seen) {
  const visible = totalTokens(seen)
  const aggregate = totalTokens(info?.tokens)
  if (aggregate <= 0) return visible <= 0
  return visible >= aggregate * 0.99 && visible <= aggregate * 1.01
}

function windowCost(info, messages, models) {
  if (!info?.tokens) return null
  const { cost, seen } = visibleMessages(messages, models)
  return windowIsComplete(info, seen) ? cost : null
}

function estimateCost(info, messages, models) {
  if (!info?.tokens) return 0
  const { cost: visible, seen, oldestModel } = visibleMessages(messages, models)
  const aggregate = info.tokens
  const rest = {
    input: Math.max(0, (aggregate.input ?? 0) - seen.input),
    output: Math.max(0, (aggregate.output ?? 0) - seen.output),
    reasoning: Math.max(0, (aggregate.reasoning ?? 0) - seen.reasoning),
    cache: {
      read: Math.max(0, (aggregate.cache?.read ?? 0) - seen.cache.read),
      write: Math.max(0, (aggregate.cache?.write ?? 0) - seen.cache.write),
    },
  }
  const viuMais = seen.input > (aggregate.input ?? 0) || seen.cache.read > (aggregate.cache?.read ?? 0)
  if (viuMais) return pricedCost(aggregate, findModel(models, info.model ?? oldestModel), 0)
  return visible + pricedCost(rest, findModel(models, oldestModel ?? info.model), 0)
}

function tailCost(messages, models) {
  let total = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.type !== "assistant") continue
    if (typeof m.cost === "number" && m.cost > 0) break
    if (!m.tokens) continue
    total += pricedCost(m.tokens, findModel(models, m.model))
  }
  return total
}

function resolveCost(real, info, messages, models) {
  const cost = typeof real === "number" && Number.isFinite(real) && real > 0 ? real : null
  if (cost === null) return { value: windowCost(info, messages, models) ?? estimateCost(info, messages, models), estimated: true }
  const tail = tailCost(messages, models)
  if (tail <= 0) return { value: cost, estimated: false }
  return { value: cost + tail, estimated: true }
}

// ---------------------------------------------------------------- fixtures
const cheap = {
  id: "deepseek-v4.1-flash",
  providerID: "opencode-go",
  cost: [{ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } }],
}
const free = {
  id: "deepseek-v4.1-flash-free",
  providerID: "opencode",
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
}
const pricey = {
  id: "qwen3.8-max",
  providerID: "opencode-go",
  cost: [{ input: 2, output: 6, cache: { read: 0.25, write: 2.5 } }],
}
const tiered = {
  id: "claude-haiku-5-5",
  providerID: "opencode-go",
  cost: [
    { input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } },
    { tier: { type: "context", size: 100_000 }, input: 0.5, output: 2.5, cache: { read: 0.05, write: 0.625 } },
  ],
}
const models = [cheap, free, pricey, tiered]

const msg = (id, model, tokens, cost) => ({ id, type: "assistant", model, tokens, ...(cost === undefined ? {} : { cost }) })
const tok = (input, output, cacheRead, reasoning = 0, cacheWrite = 0) => ({
  input,
  output,
  reasoning,
  cache: { read: cacheRead, write: cacheWrite },
})
const ref = (m) => ({ id: m.id, providerID: m.providerID })
const sumTokens = (list) =>
  list.reduce(
    (acc, m) => {
      if (m?.type !== "assistant" || !m.tokens) return acc
      acc.input += m.tokens.input ?? 0
      acc.output += m.tokens.output ?? 0
      acc.reasoning += m.tokens.reasoning ?? 0
      acc.cache.read += m.tokens.cache?.read ?? 0
      acc.cache.write += m.tokens.cache?.write ?? 0
      return acc
    },
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  )

// ---------------------------------------------------------------- helpers
test("tokensCost soma input, output e reasoning como output", () => {
  assert.equal(tokensCost(tok(1_000_000, 0, 0), cheap.cost[0]), 0.15)
  assert.equal(tokensCost(tok(0, 1_000_000, 0, 500_000), cheap.cost[0]), 0.9)
})

test("tokensCost cobra cache read e cache write", () => {
  assert.equal(tokensCost(tok(0, 0, 1_000_000, 0, 1_000_000), tiered.cost[0]), 0.01 + 0.125)
})

test("tokensCost devolve 0 sem tokens ou sem preço", () => {
  assert.equal(tokensCost(undefined, cheap.cost[0]), 0)
  assert.equal(tokensCost(tok(1000, 0, 0), undefined), 0)
})

test("tokensCost não propaga NaN de preço inválido", () => {
  const quebrado = { input: "n/a", output: 0, cache: { read: 0, write: 0 } }
  assert.equal(tokensCost(tok(1000, 0, 0), quebrado), 0)
  assert.ok(Number.isFinite(tokensCost(tok(1000, 0, 0), quebrado)))
})

test("promptTokens conta o que o modelo leu", () => {
  assert.equal(promptTokens(tok(500, 900, 1000, 50, 20)), 1520)
  assert.equal(promptTokens(undefined), 0)
})

test("pricedCost usa a faixa base abaixo do limite", () => {
  const t = tok(0, 0, 99_999)
  assert.equal(pricedCost(t, tiered), (99_999 * 0.01) / 1e6)
})

test("pricedCost usa a faixa base exatamente no limite", () => {
  const t = tok(0, 0, 100_000)
  assert.equal(pricedCost(t, tiered), (100_000 * 0.01) / 1e6)
})

test("pricedCost usa a faixa alta acima do limite", () => {
  const t = tok(0, 0, 100_001)
  assert.equal(pricedCost(t, tiered), (100_001 * 0.05) / 1e6)
})

test("pricedCost aceita dica de prompt (agregado)", () => {
  const agregado = tok(1000, 0, 10_000_000)
  assert.equal(pricedCost(agregado, tiered, 0), (1000 * 0.1 + 10_000_000 * 0.01) / 1e6)
  assert.equal(pricedCost(agregado, tiered, 200_000), (1000 * 0.5 + 10_000_000 * 0.05) / 1e6)
})

test("pricedCost devolve 0 para modelo fora do catálogo", () => {
  assert.equal(pricedCost(tok(1000, 1000, 0), null), 0)
})

// ---------------------------------------------------------------- composição
test("valor real sem cauda sem preço é exibido como está, sem ~", () => {
  const msgs = [msg("a", ref(cheap), tok(1000, 100, 0), 0.001)]
  const out = resolveCost(0.5, { tokens: sumTokens(msgs), model: ref(cheap) }, msgs, models)
  assert.equal(out.estimated, false)
  assert.equal(out.value, 0.5)
})

test("corte sintético: real + cauda reconstrói o total", () => {
  const base = [
    ["a", tok(1000, 100, 1_000_000)],
    ["b", tok(2000, 200, 2_000_000)],
    ["c", tok(3000, 300, 3_000_000)],
  ].map(([id, tokens]) => msg(id, ref(cheap), tokens, pricedCost(tokens, cheap)))
  const verdade = base.reduce((a, m) => a + m.cost, 0)
  const info = { tokens: sumTokens(base), model: ref(cheap) }
  for (const k of [1, 2]) {
    const copia = base.map((m) => ({ ...m }))
    let real = verdade
    for (let i = base.length - 1, n = 0; n < k; i--, n++) {
      real -= copia[i].cost
      copia[i].cost = 0
    }
    const out = resolveCost(real, info, copia, models)
    assert.equal(out.estimated, true)
    assert.ok(Math.abs(out.value - verdade) < 1e-12, `k=${k}: ${out.value} vs ${verdade}`)
  }
})

test("custo com tokens ausentes encerra a cauda (não re-soma mensagens antigas)", () => {
  // mensagem precificada sem tokens = marcador de fim; se o laço não parar aqui,
  // ele entra nas mensagens antigas já precificadas e conta de novo.
  const msgs = [
    msg("antiga", ref(cheap), tok(0, 0, 1_000_000), 0.003),
    { id: "marcador", type: "assistant", model: ref(cheap), cost: 0.002 },
    msg("nova", ref(cheap), tok(0, 0, 1_000_000), 0),
  ]
  const out = resolveCost(0.005, { tokens: sumTokens(msgs), model: ref(cheap) }, msgs, models)
  assert.ok(Math.abs(out.value - (0.005 + 0.003)) < 1e-12, String(out.value))
})

test("modelo grátis no meio da sessão não é cobrado", () => {
  const msgs = [
    msg("a", ref(free), tok(1000, 100, 5_000_000), 0),
    msg("b", ref(cheap), tok(1000, 100, 1_000_000), 0),
  ]
  const info = { tokens: sumTokens(msgs), model: ref(cheap) }
  const out = resolveCost(0, info, msgs, models)
  const esperado = (1000 * 0.15 + 100 * 0.6 + 1_000_000 * 0.003) / 1e6
  assert.ok(Math.abs(out.value - esperado) < 1e-12, `${out.value} vs ${esperado}`)
})

test("janela completa com exatamente 50 mensagens usa o caminho exato", () => {
  const msgs = Array.from({ length: 50 }, (_, i) => msg("m" + i, ref(cheap), tok(100, 10, 100_000), 0))
  const info = { tokens: sumTokens(msgs), model: ref(cheap) }
  const out = resolveCost(0, info, msgs, models)
  const exato = msgs.reduce((a, m) => a + pricedCost(m.tokens, cheap), 0)
  assert.ok(Math.abs(out.value - exato) < 1e-12, `${out.value} vs ${exato}`)
})

test("agregado maior que a janela cai no caminho de estimativa", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => msg("m" + i, ref(cheap), tok(100, 10, 100_000), 0))
  const info = { tokens: { ...sumTokens(msgs), cache: { read: 50_000_000, write: 0 } }, model: ref(cheap) }
  const out = resolveCost(0, info, msgs, models)
  assert.ok(out.value > msgs.reduce((a, m) => a + pricedCost(m.tokens, cheap), 0))
})

test("lista vazia com agregado preenchido não vira $0.00", () => {
  const info = { tokens: tok(5000, 500, 5_000_000), model: ref(cheap) }
  const out = resolveCost(0, info, [], models)
  const esperado = (5000 * 0.15 + 500 * 0.6 + 5_000_000 * 0.003) / 1e6
  assert.ok(Math.abs(out.value - esperado) < 1e-12, `${out.value} vs ${esperado}`)
})

test("janela vê mais tokens que o agregado (revert) e usa o agregado", () => {
  const msgs = Array.from({ length: 5 }, (_, i) => msg("m" + i, ref(cheap), tok(1000, 100, 1_000_000), 0))
  const info = { tokens: tok(100, 10, 100_000), model: ref(cheap) }
  const out = resolveCost(0, info, msgs, models)
  const agregado = (100 * 0.15 + 10 * 0.6 + 100_000 * 0.003) / 1e6
  assert.ok(Math.abs(out.value - agregado) < 1e-12, `${out.value} vs ${agregado}`)
})

test("resto é precificado pelo modelo mais antigo visível, não pelo atual", () => {
  // troca de modelo barato -> caro dentro da janela; o resto (escondido) é mais
  // antigo que o mais antigo visível, então deve seguir o barato
  const baratas = Array.from({ length: 5 }, (_, i) => msg("b" + i, ref(cheap), tok(100, 10, 100_000), 0))
  const caras = Array.from({ length: 5 }, (_, i) => msg("p" + i, ref(pricey), tok(100, 10, 100_000), 0))
  const janela = [...baratas, ...caras]
  const info = {
    model: ref(pricey),
    tokens: {
      input: 100 * 10 + 4_000_000,
      output: 200,
      reasoning: 0,
      cache: { read: 100_000 * 10 + 20_000_000, write: 0 },
    },
  }
  const out = resolveCost(0, info, janela, models)
  const comBarato = (4_000_000 * 0.15) / 1e6 + (20_000_000 * 0.003) / 1e6
  const comCaro = (4_000_000 * 2) / 1e6 + (20_000_000 * 0.25) / 1e6
  assert.ok(out.value < (comBarato + comCaro) / 2, `usou modelo caro no resto: ${out.value}`)
})

test("mensagem com cost ausente conta como sem preço", () => {
  const msgs = [msg("a", ref(cheap), tok(1000, 100, 1_000_000), 0.004), msg("b", ref(cheap), tok(0, 0, 1_000_000))]
  const info = { tokens: sumTokens(msgs), model: ref(cheap) }
  const out = resolveCost(0.004, info, msgs, models)
  assert.equal(out.estimated, true)
  assert.ok(Math.abs(out.value - 0.007) < 1e-12, String(out.value))
})

test("sessão sem mensagens e sem tokens devolve 0", () => {
  const out = resolveCost(0, { tokens: tok(0, 0, 0), model: ref(cheap) }, [], models)
  assert.equal(out.value, 0)
  assert.equal(out.estimated, true)
})

test("tokens gigantes continuam finitos", () => {
  const msgs = [msg("a", ref(cheap), tok(1e9, 1e9, 1e9), 0)]
  const out = resolveCost(0, { tokens: sumTokens(msgs), model: ref(cheap) }, msgs, models)
  assert.ok(Number.isFinite(out.value))
  assert.ok(out.value > 0)
})

test("faixa de preço entra na conta da janela", () => {
  const msgs = [msg("a", ref(tiered), tok(0, 0, 200_000), 0)]
  const out = resolveCost(0, { tokens: sumTokens(msgs), model: ref(tiered) }, msgs, models)
  assert.ok(Math.abs(out.value - (200_000 * 0.05) / 1e6) < 1e-12, String(out.value))
})

// ---------------------------------------------------------------- performance
test("estimativa de família grande fica rápida", () => {
  const msgs = Array.from({ length: 50 }, (_, i) => msg("m" + i, ref(cheap), tok(200, 50, 500_000), 0))
  const info = { tokens: { ...sumTokens(msgs), cache: { read: 900_000_000, write: 0 } }, model: ref(cheap) }
  const inicio = process.hrtime.bigint()
  for (let i = 0; i < 200; i++) resolveCost(0, info, msgs, models)
  const ms = Number(process.hrtime.bigint() - inicio) / 1e6
  assert.ok(ms < 500, `200 iterações levaram ${ms.toFixed(0)}ms`)
})

// ---------------------------------------------------------------- drift guard
test("tui.tsx mantém os marcadores da réplica", () => {
  const obrigatorios = [
    "return visible >= aggregate * 0.99 && visible <= aggregate * 1.01",
    "const viuMais = seen.input > (aggregate.input ?? 0)",
    "oldestModel ?? info.model ?? model()",
    "if (typeof msg.cost === \"number\" && msg.cost > 0) break",
    "if (!msg.tokens) continue",
    "windowCost() ?? estimateCost()",
  ]
  for (const marcador of obrigatorios) {
    assert.ok(SOURCE.includes(marcador), `marcador ausente no tui.tsx: ${marcador}`)
  }
})
