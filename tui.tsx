/** @jsxImportSource @opentui/solid */
// Barra inferior do prompt:
//   esquerda: % oficial do plano mensal (API da Go)   [prepend]
//   direita:  contexto (tokens + %) · diff git · $ sessão   [append]
// Tudo em cinza, usando tokens do tema.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, ErrorBoundary, onCleanup } from "solid-js"
import { readFileSync, watch, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// ---------------------------------------------------------------- limit tables
// Limites mensais (US$) por modelo — usados só no fallback (console/local).
const GO_LIMITS: Record<string, number> = {
  "glm-5.3-flash": 60, "glm-5.3": 15, "glm-5.2": 60,
  "kimi-k3": 15, "kimi-k2.7-code": 60, "kimi-k2.6": 60,
  "longcat-2.0": 60,
  "mimo-v2.6-flash": 60, "mimo-v2.6-pro": 15, "mimo-v2.5": 60, "mimo-v2.5-pro": 15,
  "minimax-m3": 60, "minimax-m2.7": 60,
  "muse-spark-1.3-contributor": 60, "muse-spark-1.2-contributor": 60,
  "qwen3.8-max": 15, "qwen3.8-flash": 30, "qwen3.7-plus": 60,
  "deepseek-v4.1-flash": 60, "deepseek-v4-pro": 15, "deepseek-v4-flash": 30,
  "deepseek-v4-flash-vision-exp": 15,
  "hy4-preview": 30, "hy3": 60,
  "grok-4.7": 15, "grok-4.6": 15,
  "gpt-6-luna": 15, "gpt-5.6-luna": 15,
}
const GO_PLUS_LIMITS: Record<string, number> = {
  "glm-5.3-flash": 180, "glm-5.3": 120, "glm-5.2": 180,
  "kimi-k3": 60, "kimi-k2.7-code": 180, "kimi-k2.6": 240,
  "longcat-2.0": 240,
  "mimo-v2.6-flash": 120, "mimo-v2.6-pro": 60, "mimo-v2.5": 120, "mimo-v2.5-pro": 60,
  "minimax-m3": 180, "minimax-m2.7": 240,
  "muse-spark-1.3-contributor": 120, "muse-spark-1.2-contributor": 120,
  "qwen3.8-max": 60, "qwen3.8-flash": 90, "qwen3.7-plus": 180,
  "deepseek-v4.1-flash": 120, "deepseek-v4-pro": 60, "deepseek-v4-flash": 120,
  "deepseek-v4-flash-vision-exp": 60,
  "hy4-preview": 120, "hy3": 240,
  "grok-4.7": 60, "grok-4.6": 60,
  "gpt-6-luna": 60, "gpt-5.6-luna": 60,
}

// ---------------------------------------------------------------- config
type Cycle = { mode: "billing" | "calendar" | "rolling"; day?: number }
type WindowCfg = { label: string; hours: number; share: number }
type Source = "auto" | "official" | "console" | "local"
type CompactClick = "cycle" | "toggle" | "off"
type CompactInitialsFrom = "last" | "lastTwo" | "whole"
type Compact = {
  click: CompactClick
  alias: Record<string, string>
  initials: { from: CompactInitialsFrom; min: number }
  pathLevels: string[]
  branchLevels: string[]
  hideMainBranch: boolean
  hover: boolean
  copy: boolean
  persist: "session" | "file" | "off"
  keybinds: { path: string | null; branch: string | null }
}
type Config = {
  plan: "go" | "go_plus"
  source: Source
  consoleRange: string
  cycle: Cycle
  windows: WindowCfg[]
  limits: Record<string, number>
  refreshSeconds: number
  percentBias: number
  show: { plan: boolean; context: boolean; path: boolean; branch: boolean; diff: boolean; cost: boolean; reset: boolean }
  compact: Compact
}

const DEFAULT_CONFIG: Config = {
  plan: "go",
  source: "auto",
  consoleRange: "30d",
  cycle: { mode: "billing", day: 14 },
  windows: [{ label: "30d", hours: 720, share: 1.0 }],
  limits: {},
  refreshSeconds: 60,
  percentBias: 0,
  show: { plan: true, context: true, path: false, branch: false, diff: true, cost: true, reset: false },
  compact: {
    click: "cycle",
    alias: {},
    initials: { from: "last", min: 3 },
    pathLevels: ["full", "short", "initials", "alias"],
    branchLevels: ["full", "short", "initials"],
    hideMainBranch: false,
    hover: true,
    copy: false,
    persist: "session",
    keybinds: { path: "alt+p", branch: "alt+g" },
  },
}

const SOURCES: Source[] = ["auto", "official", "console", "local"]
const CONSOLE_RANGES = ["24h", "7d", "30d", "all"]
const PATH_LEVELS = ["full", "short", "initials", "alias"]
const BRANCH_LEVELS = ["full", "short", "initials", "hidden"]

// Aceita apenas valores válidos; qualquer coisa estranha cai no default.
function normalizeConfig(parsed: any): Config {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    show: { ...DEFAULT_CONFIG.show },
    windows: [...DEFAULT_CONFIG.windows],
    limits: {},
    compact: {
      ...DEFAULT_CONFIG.compact,
      alias: {},
      initials: { ...DEFAULT_CONFIG.compact.initials },
      pathLevels: [...DEFAULT_CONFIG.compact.pathLevels],
      branchLevels: [...DEFAULT_CONFIG.compact.branchLevels],
      keybinds: { ...DEFAULT_CONFIG.compact.keybinds },
    },
  }
  const src = parsed ?? {}
  if (src.plan === "go" || src.plan === "go_plus") cfg.plan = src.plan
  if (SOURCES.includes(src.source)) cfg.source = src.source
  if (CONSOLE_RANGES.includes(src.consoleRange)) cfg.consoleRange = src.consoleRange

  const cycle = src.cycle ?? {}
  cfg.cycle = {
    mode: cycle.mode === "calendar" || cycle.mode === "rolling" ? cycle.mode : "billing",
    day: Number.isFinite(cycle.day) ? Math.min(Math.max(Math.trunc(cycle.day), 1), 28) : DEFAULT_CONFIG.cycle.day,
  }

  const windows = Array.isArray(src.windows)
    ? src.windows.filter(
        (w: any) =>
          w && typeof w.label === "string" && Number.isFinite(w.hours) && w.hours > 0 && Number.isFinite(w.share) && w.share > 0,
      )
    : []
  if (windows.length > 0) cfg.windows = windows.map((w: any) => ({ label: w.label, hours: w.hours, share: w.share }))

  if (src.limits && typeof src.limits === "object" && !Array.isArray(src.limits)) {
    for (const [key, value] of Object.entries(src.limits)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) cfg.limits[key] = value
    }
  }

  const refresh = Number(src.refreshSeconds)
  if (Number.isFinite(refresh) && refresh > 0) cfg.refreshSeconds = Math.max(10, Math.floor(refresh))

  const bias = Number(src.percentBias)
  if (Number.isFinite(bias)) cfg.percentBias = Math.min(100, Math.max(-100, Math.trunc(bias)))

  const show = src.show ?? {}
  for (const key of Object.keys(DEFAULT_CONFIG.show) as (keyof Config["show"])[]) {
    if (typeof show[key] === "boolean") cfg.show[key] = show[key]
  }

  const compact = src.compact ?? {}
  if (compact.click === "cycle" || compact.click === "toggle" || compact.click === "off") cfg.compact.click = compact.click
  if (compact.alias && typeof compact.alias === "object" && !Array.isArray(compact.alias)) {
    for (const [key, value] of Object.entries(compact.alias)) {
      if (typeof value === "string" && value.trim()) cfg.compact.alias[key] = value.trim()
    }
  }
  const ini = compact.initials ?? {}
  if (ini.from === "last" || ini.from === "lastTwo" || ini.from === "whole") cfg.compact.initials.from = ini.from
  const iniMin = Number(ini.min)
  if (Number.isFinite(iniMin)) cfg.compact.initials.min = Math.min(8, Math.max(1, Math.trunc(iniMin)))
  if (Array.isArray(compact.pathLevels)) {
    const levels = compact.pathLevels.filter((l: any) => typeof l === "string" && PATH_LEVELS.includes(l))
    if (levels.length > 0) cfg.compact.pathLevels = levels
  }
  if (Array.isArray(compact.branchLevels)) {
    const levels = compact.branchLevels.filter((l: any) => typeof l === "string" && BRANCH_LEVELS.includes(l))
    if (levels.length > 0) cfg.compact.branchLevels = levels
  }
  if (typeof compact.hideMainBranch === "boolean") cfg.compact.hideMainBranch = compact.hideMainBranch
  if (typeof compact.hover === "boolean") cfg.compact.hover = compact.hover
  if (typeof compact.copy === "boolean") cfg.compact.copy = compact.copy
  if (compact.persist === "session" || compact.persist === "file" || compact.persist === "off") cfg.compact.persist = compact.persist
  const kb = compact.keybinds ?? {}
  if (kb.path === null || typeof kb.path === "string") cfg.compact.keybinds.path = kb.path
  if (kb.branch === null || typeof kb.branch === "string") cfg.compact.keybinds.branch = kb.branch
  return cfg
}

function loadConfig(): Config {
  try {
    const raw = readFileSync(new URL("./config.json", import.meta.url), "utf8")
    return normalizeConfig(JSON.parse(raw))
  } catch {
    return DEFAULT_CONFIG
  }
}

const CONFIG = loadConfig()

// Chave de serviço do Console: env USAGE_BAR_CONSOLE_KEY (preferido) ou arquivo
// console.key ao lado do plugin (fallback). Usada na API oficial da Go
// (/zen/go/v1/usage) e no fallback do Console.
const CONSOLE_BASE = "https://opencode.ai/console"
const CONSOLE_KEY_ENV = "USAGE_BAR_CONSOLE_KEY"
// Credencial da API oficial, em ordem de preferência:
// 1. env USAGE_BAR_CONSOLE_KEY
// 2. arquivo console.key ao lado do plugin
// 3. auth.json do próprio opencode (provider "opencode-go"), já presente quando
//    a máquina está logada no plano Go — não exige console.key.
function resolveConsoleKey(): string {
  const fromEnv = (process.env[CONSOLE_KEY_ENV] ?? "").trim()
  if (fromEnv) return fromEnv
  try {
    const fromFile = readFileSync(new URL("./console.key", import.meta.url), "utf8").trim()
    if (fromFile) return fromFile
  } catch {
    // sem console.key
  }
  const dataDirs: string[] = []
  const xdg = (process.env.XDG_DATA_HOME ?? "").trim()
  if (xdg) dataDirs.push(xdg)
  try {
    dataDirs.push(join(homedir(), ".local", "share"))
  } catch {
    // sem homedir
  }
  for (const base of dataDirs) {
    try {
      const raw = JSON.parse(readFileSync(join(base, "opencode", "auth.json"), "utf8"))
      const entry = raw?.["opencode-go"] ?? raw?.["opencode"]
      const key = entry?.key
      if (typeof key === "string" && key.trim()) return key.trim()
    } catch {
      // sem auth.json nesse diretório
    }
  }
  return ""
}

let consoleKey = resolveConsoleKey()
let consoleKeyAt = Date.now()

// Revalida a cada 5 min (barato): pega login feito depois que a TUI iniciou.
function getConsoleKey(): string {
  if (Date.now() - consoleKeyAt > 300_000) {
    const next = resolveConsoleKey()
    consoleKeyAt = Date.now()
    if (next) consoleKey = next
  }
  return consoleKey
}

// ---------------------------------------------------------------- helpers
function pick(theme: any, path: string, fallback: string): string {
  try {
    let cur = theme
    for (const key of path.split(".")) cur = cur?.[key]
    return typeof cur === "string" ? cur : fallback
  } catch {
    return fallback
  }
}

const normKey = (id: string | undefined) => (id ?? "").split("/").pop()!.toLowerCase()

function monthlyLimit(model: any): number | null {
  if (!model) return null
  const byFull = CONFIG.limits[`${model.providerID}/${model.id}`] ?? CONFIG.limits[`${model.providerID}/${model.modelID}`]
  const byId = CONFIG.limits[model.id] ?? CONFIG.limits[model.modelID]
  const key = normKey(model.id ?? model.modelID)
  if (byFull != null) return byFull
  if (byId != null) return byId
  if (key.includes("free") || key.includes("unlimited")) return null
  const table = CONFIG.plan === "go_plus" ? GO_PLUS_LIMITS : GO_LIMITS
  return table[key] ?? null
}

function sameModel(ref: any, model: any): boolean {
  if (!ref || !model) return false
  if (ref.providerID !== model.providerID) return false
  return ref.id === model.id || ref.id === model.modelID || normKey(ref.id) === normKey(model.id ?? model.modelID)
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "K"
  return (n / 1_000_000).toFixed(1) + "M"
}

function fmtDur(ms: number): string {
  if (ms <= 0) return "0m"
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const mm = min % 60
  if (h < 24) return mm ? `${h}h ${mm}m` : `${h}h`
  const d = Math.floor(h / 24)
  const hh = h % 24
  return hh ? `${d}d ${hh}h` : `${d}d`
}

function cycleStart(cycle: Cycle, nowMs: number): number {
  const d = new Date(nowMs)
  if (cycle.mode === "calendar") return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const day = Math.min(Math.max(cycle.day ?? 1, 1), 28)
  let from = new Date(d.getFullYear(), d.getMonth(), day).getTime()
  if (from > nowMs) from = new Date(d.getFullYear(), d.getMonth() - 1, day).getTime()
  return from
}

// ---------------------------------------------------------------- compact (clique)
// Estado de nível por pasta/branch, compartilhado entre as duas partes do footer.
// "session" guarda só em memória; "file" persiste em compact-state.json e sincroniza
// abas/janelas via fs.watch (cada instância observa o arquivo).
const pathLevelIndex = new Map<string, number>()
const branchLevelIndex = new Map<string, number>()
const [compactTick, setCompactTick] = createSignal(0)
const COMPACT_STATE_URL = new URL("./compact-state.json", import.meta.url)
let compactStateLoaded = false
let compactStateWritten = ""
let compactWatchStarted = false
let compactWatchTimer: ReturnType<typeof setTimeout> | undefined
let lastDir = ""
let lastDisplayPath = ""
let lastBranch = ""

function applyCompactState(raw: string): void {
  try {
    const parsed = JSON.parse(raw)
    pathLevelIndex.clear()
    branchLevelIndex.clear()
    for (const [key, value] of Object.entries(parsed?.path ?? {})) if (Number.isFinite(value)) pathLevelIndex.set(key, Number(value))
    for (const [key, value] of Object.entries(parsed?.branch ?? {})) if (Number.isFinite(value)) branchLevelIndex.set(key, Number(value))
    setCompactTick((t) => t + 1)
  } catch {
    // arquivo sendo escrito por outra instância; o próximo evento tenta de novo
  }
}

function loadCompactState(): void {
  if (compactStateLoaded) return
  compactStateLoaded = true
  if (CONFIG.compact.persist !== "file") return
  try {
    const raw = readFileSync(COMPACT_STATE_URL, "utf8")
    applyCompactState(raw)
    compactStateWritten = raw
  } catch {
    // sem estado salvo
  }
}

function saveCompactState(): void {
  if (CONFIG.compact.persist !== "file") return
  try {
    const text = JSON.stringify(
      { path: Object.fromEntries(pathLevelIndex), branch: Object.fromEntries(branchLevelIndex) },
      null,
      2,
    )
    writeFileSync(COMPACT_STATE_URL, text)
    compactStateWritten = text
  } catch {
    // sem permissão de escrita
  }
}

function refreshCompactState(): void {
  try {
    const raw = readFileSync(COMPACT_STATE_URL, "utf8")
    if (raw === compactStateWritten) return
    applyCompactState(raw)
    compactStateWritten = raw
  } catch {
    // sem arquivo ainda
  }
}

// Com "file", qualquer instância que escrever avisa as outras: compacta numa aba e as
// demais refletem. fs.watch com debounce + varredura periódica como rede de segurança.
function startCompactWatch(): void {
  if (compactWatchStarted) return
  compactWatchStarted = true
  if (CONFIG.compact.persist !== "file") return
  setInterval(refreshCompactState, 2000)
  try {
    watch(new URL(".", COMPACT_STATE_URL), (_event, filename) => {
      const name = typeof filename === "string" ? filename : String(filename ?? "")
      if (name && name !== "compact-state.json") return
      if (compactWatchTimer) clearTimeout(compactWatchTimer)
      compactWatchTimer = setTimeout(refreshCompactState, 150)
    })
  } catch {
    // fs.watch indisponível; a varredura cobre
  }
}

function segmentsOf(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s && s !== "~")
}

function lastSegment(display: string): string {
  const segs = segmentsOf(display)
  return segs[segs.length - 1] ?? display
}

function wordsOf(s: string): string[] {
  return s.split(/[.\-_\s]+/).filter(Boolean)
}

function initialsOf(s: string, min = 3): string {
  const ws = wordsOf(s)
  if (ws.length === 0) return s
  if (ws.length === 1) return ws[0].slice(0, Math.max(min, 1))
  return ws.map((w) => w[0]).join("")
}

function initialsPath(display: string, from: CompactInitialsFrom, min: number): string {
  const segs = segmentsOf(display)
  const picked = from === "whole" ? segs : from === "lastTwo" ? segs.slice(-2) : segs.slice(-1)
  const out = picked.map((s) => initialsOf(s, min)).join("/")
  return out || display
}

function aliasFor(dir: string, display: string, alias: Record<string, string>): string | null {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  const full = norm(dir)
  for (const [key, value] of Object.entries(alias)) if (norm(key) === full) return value
  const base = norm(display).split("/").filter(Boolean).pop() ?? ""
  for (const [key, value] of Object.entries(alias)) if (key.replace(/\\/g, "/").toLowerCase() === base) return value
  return null
}

function branchShort(b: string, max = 20): string {
  if (b.length <= max) return b
  const segs = b.split(/[\\/]+/).filter(Boolean)
  if (segs.length >= 2) {
    const head = segs[0].slice(0, 4)
    const rest = segs.slice(1).join("-")
    return `${head}/${rest.slice(0, Math.max(1, max - head.length - 2))}\u2026`
  }
  return b.slice(0, max - 1) + "\u2026"
}

function branchInitials(b: string): string {
  const segs = b.split(/[\\/]+/).filter(Boolean)
  if (segs.length === 0) return b
  const head = segs[0].slice(0, 4)
  const rest = segs.slice(1).join("-")
  const ini = wordsOf(rest).map((w) => w[0]).join("")
  return ini ? `${head}/${ini}` : head
}

const isMainBranch = (b: string) => b === "main" || b === "master"

function pathLevelsFor(dir: string, display: string): string[] {
  let levels = CONFIG.compact.pathLevels.filter((l) => PATH_LEVELS.includes(l))
  if (levels.includes("alias") && !aliasFor(dir, display, CONFIG.compact.alias)) levels = levels.filter((l) => l !== "alias")
  if (!levels.includes("full")) levels.unshift("full")
  // Níveis que renderizam o mesmo texto (ex.: full == short em caminho curto) ficam de fora,
  // senão o primeiro clique não muda nada na tela.
  const seen = new Set<string>()
  levels = levels.filter((level) => {
    const text = levelText(level, dir, display)
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
  if (CONFIG.compact.click === "off") return ["full"]
  if (CONFIG.compact.click === "toggle") {
    const last = levels[levels.length - 1]
    return last && last !== "full" ? ["full", last] : ["full"]
  }
  return levels
}

function branchLevelsFor(b: string): string[] {
  let levels = CONFIG.compact.branchLevels.filter((l) => BRANCH_LEVELS.includes(l))
  if (!CONFIG.compact.hideMainBranch || !isMainBranch(b)) levels = levels.filter((l) => l !== "hidden")
  if (!levels.includes("full")) levels.unshift("full")
  // Remove níveis com o mesmo texto (ex.: branch curta que já é igual à completa).
  const seen = new Set<string>()
  levels = levels.filter((level) => {
    const text = branchLevelText(level, b)
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
  if (CONFIG.compact.click === "off") return ["full"]
  if (CONFIG.compact.click === "toggle") {
    const last = levels[levels.length - 1]
    return last && last !== "full" ? ["full", last] : ["full"]
  }
  return levels
}

function currentLevel(map: Map<string, number>, key: string, levels: string[]): string {
  const i = Math.min(Math.max(map.get(key) ?? 0, 0), levels.length - 1)
  return levels[i] ?? "full"
}

function cycleLevel(map: Map<string, number>, key: string, levels: string[], delta: number): void {
  if (!key || levels.length <= 1) return
  loadCompactState()
  const i = map.get(key) ?? 0
  map.set(key, (((i + delta) % levels.length) + levels.length) % levels.length)
  saveCompactState()
  setCompactTick((t) => t + 1)
}

function levelText(level: string, dir: string, display: string): string {
  switch (level) {
    case "full":
      return display
    case "short":
      // Intermediário: só a última pasta (~/GitLab/in.pulse-analytics -> in.pulse-analytics).
      return lastSegment(display)
    case "initials":
      return initialsPath(display, CONFIG.compact.initials.from, CONFIG.compact.initials.min)
    case "alias":
      return aliasFor(dir, display, CONFIG.compact.alias) ?? initialsPath(display, CONFIG.compact.initials.from, CONFIG.compact.initials.min)
    default:
      return display
  }
}

function branchLevelText(level: string, b: string): string {
  switch (level) {
    case "short":
      return branchShort(b)
    case "initials":
      return branchInitials(b)
    case "hidden":
      return ""
    default:
      return b
  }
}

function copyText(text: string): void {
  try {
    process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`)
  } catch {
    // terminal sem OSC 52
  }
}

function cycleFromKey(kind: "path" | "branch"): void {
  if (!lastDir) return
  if (kind === "path") {
    cycleLevel(pathLevelIndex, lastDir, pathLevelsFor(lastDir, lastDisplayPath || lastDir), 1)
  } else if (lastBranch) {
    cycleLevel(branchLevelIndex, lastBranch, branchLevelsFor(lastBranch), 1)
  }
}

loadCompactState()
startCompactWatch()

// GET JSON com timeout/abort; null em qualquer falha (rede, status, parse).
async function getJson(url: string, timeoutMs = 10_000): Promise<any | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${getConsoleKey()}`, Accept: "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Resolve null se a promise não terminar a tempo (chamadas locais do client).
function deadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

// uso OFICIAL do plano Go (rolling/semanal/mensal), direto da API da Go
type OfficialUsage = { percent: number; resetsAt: number | null }
async function fetchOfficialUsage(): Promise<OfficialUsage | null> {
  if (!getConsoleKey()) return null
  const data = await getJson("https://opencode.ai/zen/go/v1/usage")
  const monthly = data?.usage?.monthly
  if (!monthly || typeof monthly.percent !== "number" || !Number.isFinite(monthly.percent)) return null
  const parsed = monthly.resetsAt ? Date.parse(monthly.resetsAt) : NaN
  return { percent: monthly.percent, resetsAt: Number.isFinite(parsed) ? parsed : null }
}

// custo do modelo via API do Console (fallback account-wide)
async function consoleModelCost(m: any): Promise<number | null> {
  if (!getConsoleKey()) return null
  const data = await getJson(`${CONSOLE_BASE}/api/usage/models?range=${encodeURIComponent(CONFIG.consoleRange)}`, 15_000)
  if (data === null) return null
  const items = Array.isArray(data?.items) ? data.items : []
  const hit = items.find(
    (it: any) =>
      it.provider === m.providerID &&
      (it.model === m.id || it.model === m.modelID || normKey(it.model) === normKey(m.id ?? m.modelID)),
  )
  return hit ? Number(hit.totalCostMicroCents) / 1e8 : 0
}

// ---------------------------------------------------------------- component
function UsageBar(props: { context: any; sessionID: string; part: "plan" | "rest" }) {
  const ctx = props.context
  const theme = ctx.theme
  const client = ctx.client
  const part = props.part

  const muted = pick(theme, "text.muted", "#8f8f8f")
  const bright = pick(theme, "text.default", pick(theme, "text.primary", pick(theme, "text.normal", "#d0d0d0")))
  const [hover, setHover] = createSignal<"path" | "branch" | null>(null)

  const [official, setOfficial] = createSignal<OfficialUsage | null>(null)
  const [meters, setMeters] = createSignal<any[]>([])
  const [diff, setDiff] = createSignal<{ add: number; del: number } | null>(null)
  const [now, setNow] = createSignal(Date.now())
  let lastFetch = 0
  let lastModelKey = ""
  let syncedDir = ""
  let generation = 0
  let inFlight = false
  let queued = false

  const model = createMemo(() => ctx.ui.model.current() ?? ctx.data.session.get(props.sessionID)?.model ?? null)
  const session = createMemo(() => ctx.data.session.get(props.sessionID))
  const location = createMemo(() => session()?.location ?? ctx.location ?? null)

  const dirKey = createMemo(() => location()?.directory ?? "")

  const displayPath = createMemo(() => {
    const dir = location()?.directory
    if (!dir) return null
    try {
      return ctx.ui.format.path(dir)
    } catch {
      return dir
    }
  })

  const branch = createMemo(() => {
    try {
      const loc = location()
      if (!loc?.directory) return null
      return ctx.data.location.vcs.info(loc)?.branch?.current ?? null
    } catch {
      return null
    }
  })

  // Alimenta os keybinds e a memória de nível por pasta.
  createEffect(() => {
    lastDir = dirKey()
    lastDisplayPath = displayPath() ?? ""
    lastBranch = branch() ?? ""
  })

  const context = createMemo(() => {
    let msgs: any[] = []
    try {
      msgs = ctx.data.session.message.list(props.sessionID) ?? []
    } catch {
      msgs = []
    }
    let last: any = null
    for (const msg of msgs) if (msg?.type === "assistant" && msg?.tokens) last = msg
    if (!last) return null
    const tk = last.tokens
    const tokens = (tk.input ?? 0) + (tk.output ?? 0) + (tk.reasoning ?? 0) + (tk.cache?.read ?? 0) + (tk.cache?.write ?? 0)
    if (tokens <= 0) return null
    let pct: number | undefined
    try {
      const models = ctx.data.location.model.list(session()?.location) ?? []
      const info = models.find((x: any) => sameModel(last.model, x))
      if (info?.limit?.context) pct = Math.round((tokens / info.limit.context) * 100)
    } catch {
      pct = undefined
    }
    return { tokens, pct }
  })

  const planPct = createMemo(() => {
    const w = meters()[0]
    if (!w || w.percent === null || w.percent === undefined) return null
    return Math.round(w.percent * 100)
  })

  async function statsFor(m: any, from: number, to: number): Promise<any | null> {
    try {
      const res = await deadline(Promise.resolve(client.session.stats({ from, to, tools: "none" })), 15_000)
      return res?.data ?? res ?? null
    } catch {
      return null
    }
  }

  async function fetchWindow(m: any, w: WindowCfg, nowMs: number) {
    const from = CONFIG.cycle.mode === "rolling" ? nowMs - w.hours * 3_600_000 : cycleStart(CONFIG.cycle, nowMs)
    let cost: number | null = null
    if (CONFIG.source !== "local") cost = await consoleModelCost(m)
    if (cost === null && CONFIG.source !== "console") {
      const info = await statsFor(m, from, nowMs)
      if (info) {
        const usage = (info.models ?? []).find((u: any) => sameModel(u.model, m))
        cost = usage?.cost ?? 0
      }
    }
    if (cost === null) return null
    const limit = monthlyLimit(m)
    const allowance = limit != null ? limit * w.share : null
    const percent = allowance ? cost / allowance : null
    return { percent, cost }
  }

  async function computeDiff(): Promise<{ add: number; del: number } | null> {
    const dir = location()?.directory
    if (!dir) return null
    try {
      const res = await deadline(Promise.resolve(client.vcs.status({ location: { directory: dir } })), 15_000)
      const rows = res?.data ?? res ?? []
      if (!Array.isArray(rows)) return null
      let add = 0
      let del = 0
      for (const r of rows) {
        add += Number(r?.additions ?? 0)
        del += Number(r?.deletions ?? 0)
      }
      return { add, del }
    } catch {
      return null
    }
  }

  async function refresh(force = false) {
    const nowMs = Date.now()
    const m = model()
    const key = m ? `${m.providerID}/${m.id ?? m.modelID}` : ""
    if (!force && key === lastModelKey && nowMs - lastFetch < CONFIG.refreshSeconds * 1000) return
    lastModelKey = key
    lastFetch = nowMs

    // Uma atualização por vez; se algo mudar durante a atualização, repete no fim.
    if (inFlight) {
      queued = true
      return
    }
    inFlight = true
    const gen = generation
    try {
      if (part === "rest") {
        const d = await computeDiff()
        if (gen === generation) setDiff(d)
      }

      if (part === "plan" && CONFIG.show.plan) {
        let officialOk = false
        // O % oficial é do plano inteiro: busca sempre, mesmo sem modelo selecionado.
        if (CONFIG.source === "official" || CONFIG.source === "auto") {
          const o = await fetchOfficialUsage()
          if (gen !== generation) return
          if (o) {
            officialOk = true
            setOfficial(o)
            setMeters([])
          } else {
            setOfficial(null)
          }
        } else {
          setOfficial(null)
        }

        const fallbackAllowed = !officialOk && CONFIG.source !== "official"
        if (fallbackAllowed && m) {
          const results = await Promise.all(CONFIG.windows.map((w) => fetchWindow(m, w, nowMs)))
          if (gen === generation) setMeters(results.filter((r) => r !== null))
        } else if (fallbackAllowed && gen === generation) {
          setMeters([])
        }
      }
    } finally {
      inFlight = false
      if (queued) {
        queued = false
        // Só repete se o escopo (sessão/modelo/pasta) mudou durante a atualização.
        if (gen !== generation) void refresh(true)
      }
    }
  }

  // Escopo = sessão + pasta + modelo. Mudanças de custo/tokens durante o streaming
  // não invalidam a requisição em voo; trocas de escopo sim.
  let lastScope = ""
  createEffect(() => {
    const m = model()
    session()
    const scope = `${props.sessionID}\u0000${session()?.location?.directory ?? ""}\u0000${m?.providerID ?? ""}/${m?.id ?? m?.modelID ?? ""}`
    const changed = scope !== lastScope
    if (changed) {
      lastScope = scope
      generation++
    }
    void refresh(changed)
  })

  if (part === "plan" && CONFIG.show.branch) {
    createEffect(() => {
      const loc = location()
      const dir = loc?.directory
      if (!dir || syncedDir === dir) return
      syncedDir = dir
      try {
        void Promise.resolve(ctx.data.location.vcs.sync(loc)).catch(() => {})
      } catch {
        // sem vcs disponível
      }
    })
  }

  const refreshTimer = setInterval(() => void refresh(true), CONFIG.refreshSeconds * 1000)
  onCleanup(() => clearInterval(refreshTimer))

  const clock = setInterval(() => setNow(Date.now()), 15_000)
  onCleanup(() => clearInterval(clock))

  // ---------------------------------------------------------------- compact (clique)
  const pathText = createMemo(() => {
    compactTick()
    if (!CONFIG.show.path) return null
    const dir = dirKey()
    const display = displayPath()
    if (!dir || !display) return null
    const levels = pathLevelsFor(dir, display)
    return levelText(currentLevel(pathLevelIndex, dir, levels), dir, display)
  })

  const branchText = createMemo(() => {
    compactTick()
    if (!CONFIG.show.branch) return null
    const b = branch()
    if (!b) return null
    const levels = branchLevelsFor(b)
    return branchLevelText(currentLevel(branchLevelIndex, b, levels), b)
  })

  const planText = createMemo(() => {
    const o = official()
    const rawPct = o ? o.percent : planPct()
    const pct = rawPct === null ? null : Math.max(0, rawPct + (CONFIG.percentBias || 0))
    // Sem dado oficial, o percentual vem do fallback (aproximado): marca com "~".
    if (!CONFIG.show.plan || pct === null) return null
    return o ? `${pct}%` : `~${pct}%`
  })

  const resetText = createMemo(() => {
    const o = official()
    if (!CONFIG.show.reset || !o?.resetsAt) return null
    return `\u21BB ${fmtDur(o.resetsAt! - now())}`
  })

  function isLeftClick(e: any) {
    // `button` pode vir undefined/0/"left" (normal) ou 3 (release em algumas codificações de terminal).
    const b = e?.button
    return b === undefined || b === null || b === 0 || b === 3 || b === "left"
  }

  function clickPath(e: any) {
    if (!isLeftClick(e)) return
    e?.stopPropagation?.()
    const dir = dirKey()
    const display = displayPath()
    if (!dir || !display || CONFIG.compact.click === "off") return
    const levels = pathLevelsFor(dir, display)
    if (e?.modifiers?.alt) cycleLevel(pathLevelIndex, dir, levels, -1)
    else if (e?.modifiers?.shift && CONFIG.compact.copy) copyText(display)
    else cycleLevel(pathLevelIndex, dir, levels, 1)
  }

  function clickBranch(e: any) {
    if (!isLeftClick(e)) return
    e?.stopPropagation?.()
    const b = branch()
    if (!b || CONFIG.compact.click === "off") return
    const levels = branchLevelsFor(b)
    if (e?.modifiers?.alt) cycleLevel(branchLevelIndex, b, levels, -1)
    else if (e?.modifiers?.shift && CONFIG.compact.copy) copyText(b)
    else cycleLevel(branchLevelIndex, b, levels, 1)
  }

  const rightText = createMemo(() => {
    const parts: string[] = []
    if (CONFIG.show.context && context()) {
      const c = context()!
      parts.push(`${fmtTokens(c.tokens)}${c.pct !== undefined ? ` (${c.pct}%)` : ""}`)
    }
    if (CONFIG.show.diff && diff()) parts.push(`(+${diff()!.add} -${diff()!.del})`)
    if (CONFIG.show.cost) {
      let cost = 0
      try {
        // data.session.cost soma a família toda (sessão + subagentes) quando é a raiz
        cost = ctx.data.session.cost(props.sessionID) ?? 0
      } catch {
        cost = session()?.cost ?? 0
      }
      parts.push(`$${cost.toFixed(2)}`)
    }
    return parts.join("  ")
  })

  if (part === "plan") {
    const hot = (kind: "path" | "branch") => (CONFIG.compact.hover && hover() === kind ? bright : muted)
    return (
      <ErrorBoundary fallback={<text fg={muted} />}>
        <box flexDirection="row">
          {pathText() ? (
            <box
              onMouseOver={() => CONFIG.compact.hover && setHover("path")}
              onMouseOut={() => hover() === "path" && setHover(null)}
              onMouseUp={clickPath}
            >
              <text fg={hot("path")}>{pathText()}</text>
            </box>
          ) : null}
          {pathText() && branchText() ? <text fg={muted}>{"  "}</text> : null}
          {branchText() ? (
            <box
              onMouseOver={() => CONFIG.compact.hover && setHover("branch")}
              onMouseOut={() => hover() === "branch" && setHover(null)}
              onMouseUp={clickBranch}
            >
              <text fg={hot("branch")}>{`git:${branchText()}`}</text>
            </box>
          ) : null}
          {(pathText() || branchText()) && planText() ? <text fg={muted}>{"  "}</text> : null}
          {planText() ? <text fg={muted}>{planText()}</text> : null}
          {resetText() ? <text fg={muted}>{"  "}</text> : null}
          {resetText() ? <text fg={muted}>{resetText()}</text> : null}
        </box>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary fallback={<text fg={muted} />}>
      <text fg={muted}>{rightText()}</text>
    </ErrorBoundary>
  )
}

// ---------------------------------------------------------------- host fix
// O rodapé nativo do host renderiza "pasta:branch" num <text id="prompt.footer.location">
// dentro de prompt.footer.status. O plugin é dono da linha (pasta/branch no grupo da
// esquerda), então escondemos o elemento nativo (visible=false remove do layout via yoga).
// O host remonta o elemento de tempos em tempos (dica ativa, troca de sessão), por isso
// reaplicamos periodicamente. Se a API interna mudar, o plugin simplesmente não esconde.
function hideBuiltinLocation(context: any): void {
  try {
    const el = context.renderer?.root?.findDescendantById?.("prompt.footer.location")
    if (el && el.visible !== false) el.visible = false
  } catch {
    // API interna do host; falha silenciosa
  }
}

// ---------------------------------------------------------------- plugin
export default Plugin.define({
  id: "luccas.usage-bar",
  setup(context) {
    hideBuiltinLocation(context)
    const hostFixTimer = setInterval(() => hideBuiltinLocation(context), 1000)

    // % do plano no extremo esquerdo da linha
    context.ui.slot({
      prepend: "prompt.footer",
      render: (props) => <UsageBar context={context} sessionID={props.sessionID} part="plan" />,
    })
    // contexto, diff e custo à direita
    context.ui.slot({
      append: "prompt.footer",
      render: (props) => <UsageBar context={context} sessionID={props.sessionID} part="rest" />,
    })

    // Fallback de teclado caso o clique não chegue no rodapé (compact.keybinds; null desliga).
    const keys = CONFIG.compact.keybinds
    if (keys.path || keys.branch) {
      context.keymap.layer(() => ({
        commands: [
          ...(keys.path
            ? [
                {
                  id: "usage-bar.compact.path",
                  title: "usage-bar: pasta compacta/expandida",
                  group: "usage-bar",
                  bind: keys.path,
                  run: () => cycleFromKey("path"),
                },
              ]
            : []),
          ...(keys.branch
            ? [
                {
                  id: "usage-bar.compact.branch",
                  title: "usage-bar: branch compacta/expandida",
                  group: "usage-bar",
                  bind: keys.branch,
                  run: () => cycleFromKey("branch"),
                },
              ]
            : []),
        ],
      }))
    }

    return () => clearInterval(hostFixTimer)
  },
})
