// Sync the monthly per-model limits from the official Go docs into tui.tsx.
//
// The limits are not exposed by any API: /inference/go/v1/models returns only model
// ids, and the Console usage endpoints return cost, not allowance. The docs table is
// the source of truth, so this script parses it and rewrites GO_LIMITS/GO_PLUS_LIMITS.
//
// Usage:
//   bun run scripts/sync-limits.ts          # rewrite tui.tsx
//   bun run scripts/sync-limits.ts --check  # exit 1 if tui.tsx is out of date

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const DOCS_URL = "https://opencode.ai/docs/go"
const MODELS_URL = "https://opencode.ai/inference/go/v1/models"
const TUI_PATH = fileURLToPath(new URL("../tui.tsx", import.meta.url))
const CHECK = process.argv.includes("--check")

type Limits = Map<string, number>

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
}

// "GLM-5.3-Flash" -> "glm-5.3-flash", "Qwen3.7 Plus (≤ 256K tokens)" -> "qwen3.7-plus"
function modelId(label: string): string {
  return label
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "")
}

// Docs labels and model ids disagree on separators ("Claude Haiku 5.5" vs
// "claude-haiku-5-5"), so compare with everything but letters/digits removed.
const loose = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "")

function resolveId(label: string, ids: string[]): string {
  const base = label.replace(/\([^)]*\)/g, " ").trim()
  return ids.find((id) => loose(id) === loose(base)) ?? modelId(label)
}

function pricingTables(html: string): string[][] {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)]
    .map((m) =>
      [...m[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) =>
        [...r[0].matchAll(/<t[dh][\s\S]*?<\/t[dh]>/g)].map((c) => text(c[0])),
      ),
    )
    // Pricing tables have a dollar value in the last cell; request estimates do not.
    .filter((rows) => rows.length > 1 && rows.slice(1).some((r) => /\$\d/.test(r[r.length - 1] ?? "")))
}

function toLimits(rows: string[][], ids: string[]): Limits {
  const out: Limits = new Map()
  for (const row of rows.slice(1)) {
    // Discounted rows look like "~~$30~~ $60 2x · Limited time": the last price wins.
    const values = [...(row[row.length - 1] ?? "").matchAll(/\$(\d+)/g)]
    const value = values[values.length - 1]
    if (value) out.set(resolveId(row[0], ids), Number(value[1]))
  }
  return out
}

function readBlock(source: string, name: string): Limits {
  const match = source.match(new RegExp(`const ${name}: Record<string, number> = \\{([\\s\\S]*?)\\n\\}`))
  const out: Limits = new Map()
  if (!match) return out
  for (const pair of match[1].matchAll(/"([^"]+)":\s*(\d+)/g)) out.set(pair[1], Number(pair[2]))
  return out
}

function render(name: string, limits: Limits): string {
  const entries = [...limits].map(([key, value]) => `"${key}": ${value}`)
  const lines: string[] = []
  for (let i = 0; i < entries.length; i += 4) lines.push("  " + entries.slice(i, i + 4).join(", ") + ",")
  return `const ${name}: Record<string, number> = {\n${lines.join("\n")}\n}`
}

function merge(known: Limits, docs: Limits): Limits {
  const out: Limits = new Map(known)
  for (const [key, value] of docs) out.set(key, value)
  return out
}

const html = await (await fetch(DOCS_URL)).text()
const tables = pricingTables(html)
if (tables.length < 2) {
  console.error(`expected 2 pricing tables on ${DOCS_URL}, found ${tables.length}`)
  process.exit(1)
}
const modelList = (await (await fetch(MODELS_URL)).json()) as { data?: { id?: string }[] }
const ids = (modelList.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id))
const go = toLimits(tables[0], ids)
const goPlus = toLimits(tables[1], ids)
if (go.size < 10 || goPlus.size < 10) {
  console.error(`suspiciously small tables: go=${go.size} go-plus=${goPlus.size}`)
  process.exit(1)
}

const source = await readFile(TUI_PATH, "utf8")
const currentGo = readBlock(source, "GO_LIMITS")
const currentGoPlus = readBlock(source, "GO_PLUS_LIMITS")
const nextGo = merge(currentGo, go)
const nextGoPlus = merge(currentGoPlus, goPlus)

const changes: string[] = []
for (const [key, value] of nextGo) {
  if (currentGo.get(key) !== value) changes.push(`GO_LIMITS ${key}: ${currentGo.get(key) ?? "-"} -> ${value}`)
}
for (const [key, value] of nextGoPlus) {
  if (currentGoPlus.get(key) !== value) changes.push(`GO_PLUS_LIMITS ${key}: ${currentGoPlus.get(key) ?? "-"} -> ${value}`)
}

const updated = source
  .replace(/const GO_LIMITS: Record<string, number> = \{[\s\S]*?\n\}/, render("GO_LIMITS", nextGo))
  .replace(/const GO_PLUS_LIMITS: Record<string, number> = \{[\s\S]*?\n\}/, render("GO_PLUS_LIMITS", nextGoPlus))

if (changes.length === 0) {
  console.log(`limits are in sync (${nextGo.size} go, ${nextGoPlus.size} go plus models)`)
  const withoutLimit = ids.filter((id) => !nextGo.has(id))
  if (withoutLimit.length) console.log(`no published limit (local estimate unavailable): ${withoutLimit.join(", ")}`)
  process.exit(0)
}
if (CHECK) {
  console.error("limits are out of date:\n" + changes.join("\n"))
  process.exit(1)
}
await writeFile(TUI_PATH, updated)
console.log(`updated ${changes.length} entries:\n` + changes.join("\n"))
