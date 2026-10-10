// image-slim — magpie gateway middleware.
//
// Agents resend every image in a conversation on every turn: Codex sends the
// whole transcript to a stateless provider, and the images in it are inline
// base64. A thread with a few dozen screenshots therefore uploads tens of MB
// per request even when the turn is pure text. See openai/codex#35732,
// #46761, #45971 and #33760.
//
// This middleware runs in magpie's gateway, before routing, on what the agent
// sends. It keeps the newest images and swaps the older ones for a short text
// placeholder, so the bytes never leave the machine. A placeholder names the
// local file the image came from — the tool call that produced it is still in
// the request — so the agent can read it back with view_image when it really
// needs to look again.
//
// A middleware may import only files beside it, so this is plain JavaScript:
// no node: modules, no dependencies.
//
// Options (magpie plugin options image-slim '<json>'):
//   keep_last          2      how many of the newest images stay untouched
//   keep_last_turns    0      how many finished turns keep all their images
//   keep_current_turn  true   never touch images from the turn being sent
//   min_bytes          8192   leave images smaller than this alone
//   agents             ["codex"]  only these agents ([] = every agent)
//   models             []     only these models ([] = every model)
//   tools              []     only these tools' results ([] = every tool)
//   attachments        true   also slim images the user pasted or attached
//   placeholder        ""     your own text; "" uses the built-in wording
//   log                true   write what was saved to magpie's log

// Codex is the agent this was written for: it is the one that resends a whole
// transcript on every turn. magpie names the caller after the program it sees,
// so a Codex session run by another app arrives under that app's name and is
// left alone until you add it here yourself.
const DEFAULT_AGENTS = ["codex"]

// onRequest is called with the body the agent sent, before magpie routes it.
// Return the body to send a changed one, undefined to send it as it came.
export function onRequest(body, ctx) {
  const o = options(ctx.options)
  if (!o) return
  if (o.agents.length && !o.agents.includes(ctx.agent)) return
  if (o.models.length && !o.models.includes(ctx.model)) return

  const found = collect(body, ctx.protocol)
  if (!found || !found.images.length) return

  const keep = keepSet(found, o)

  const before = found.images.reduce((n, img) => n + img.bytes, 0)
  let slimmed = 0
  let after = before
  for (const img of found.images) {
    if (keep.has(img)) continue
    if (img.bytes < o.min_bytes) continue
    if (!o.attachments && img.kind === "attachment") continue
    if (o.tools.length && img.kind === "tool" && !o.tools.includes(img.tool)) continue
    const text = placeholder(o, img)
    img.set(text)
    slimmed++
    after -= img.bytes
  }
  if (!slimmed) return
  if (o.log) console.log(`image-slim: [${ctx.agent}] ${slimmed} image(s) left out, ${mb(before)} MB of images -> ${mb(after)} MB (${found.images.length - slimmed} kept)`)
  return body
}

// keepSet is what stays inline: the newest keep_last images, every image of
// the newest keep_last_turns finished turns, and — unless that is turned off —
// every image of the turn being sent.
//
// A finished turn is one the agent has already answered; keeping one whole
// turn is what keep_last_turns is for, since a count of images can cut a turn
// in half and leave the model looking at three of a turn's five screenshots.
// keep_last_turns 0, with keep_last 0, keeps the turn being sent and nothing
// else: every image the agent has already replied about becomes a placeholder.
function keepSet(found, o) {
  const keep = new Set()
  if (o.keep_last > 0) for (const img of found.images.slice(-o.keep_last)) keep.add(img)

  const floors = []
  if (o.keep_current_turn) floors.push(turnStart(found.turns, 1))
  if (o.keep_last_turns > 0) floors.push(turnStart(found.turns, o.keep_last_turns + 1))
  const floor = floors.filter((at) => at >= 0).sort((a, b) => a - b)[0]
  if (floor !== undefined) for (const img of found.images) if (img.index >= floor) keep.add(img)

  return keep
}

// turnStart is where the nth-newest turn begins, counting the turn being sent
// as 1. Asking for more turns than the request has means its first turn, and a
// request with no turn at all has nothing to anchor on, so it is -1.
function turnStart(turns, n) {
  if (!turns.length) return -1
  return turns[Math.max(0, turns.length - n)]
}

function options(raw) {
  const o = raw && typeof raw === "object" ? raw : {}
  const num = (v, d) => (typeof v === "number" && isFinite(v) && v >= 0 ? Math.floor(v) : d)
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [])
  return {
    keep_last: num(o.keep_last, 2),
    keep_last_turns: num(o.keep_last_turns, 0),
    keep_current_turn: o.keep_current_turn !== false,
    min_bytes: num(o.min_bytes, 8192),
    // An explicit [] means every agent; leaving the option out means Codex.
    agents: "agents" in o ? list(o.agents) : DEFAULT_AGENTS,
    models: list(o.models),
    tools: list(o.tools),
    attachments: o.attachments !== false,
    placeholder: typeof o.placeholder === "string" ? o.placeholder : "",
    log: o.log !== false,
  }
}

// collect walks the request in its API's shape and returns every inline image,
// in the order the agent sent them, with a setter that swaps it for text, and
// where each turn in it starts.
function collect(body, protocol) {
  if (!body || typeof body !== "object") return null
  if (protocol === "responses") return collectResponses(body)
  if (protocol === "anthropic") return collectAnthropic(body)
  if (protocol === "gemini") return collectGemini(body)
  return collectChat(body)
}

// A turn starts at a message the user sent. Tool results are not turns even
// where an API carries them in a user-role message: Claude Code's tool_result
// and Gemini's functionResponse both come back that way, and the turn they
// belong to began earlier. An image with no words beside it is still a turn.
function collectResponses(body) {
  const input = Array.isArray(body.input) ? body.input : null
  if (!input) return null
  const calls = new Map()
  for (const it of input) {
    if (it && it.type === "function_call" && it.call_id) calls.set(it.call_id, it)
  }
  const images = []
  const turns = []
  input.forEach((it, index) => {
    if (!it) return
    if (it.type === "message" && it.role === "user") turns.push(index)
    if (it.type === "message" && Array.isArray(it.content)) {
      it.content.forEach((part, at) => {
        if (!isDataUrlPart(part, "input_image", "image_url")) return
        images.push({
          index, kind: "attachment", tool: "", path: "", mime: mimeOf(part.image_url),
          // bytes is what would actually leave the machine: the base64 payload.
          bytes: part.image_url.length, dataUrl: part.image_url,
          set: (text) => { it.content[at] = { type: "input_text", text } },
        })
      })
    } else if (it.type === "function_call_output" && Array.isArray(it.output)) {
      const parts = it.output.filter((p) => isDataUrlPart(p, "input_image", "image_url"))
      if (!parts.length) return
      const call = calls.get(it.call_id)
      images.push({
        index, kind: "tool", tool: call?.name || "", path: pathOf(call), mime: mimeOf(parts[0].image_url),
        bytes: parts.reduce((n, p) => n + p.image_url.length, 0),
        dataUrl: parts[0].image_url,
        // A function_call_output's output takes a plain string, which every
        // Responses-compatible server accepts.
        set: (text) => { it.output = text },
      })
    }
  })
  return { images, turns }
}

function collectAnthropic(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const images = []
  const turns = []
  msgs.forEach((m, index) => {
    if (m?.role === "user" && !onlyToolResults(m.content)) turns.push(index)
    const list = Array.isArray(m?.content) ? m.content : null
    if (!list) return
    // An image sits either in the message's own content or inside a
    // tool_result, which is where Claude Code's screenshots land.
    walkAnthropic(list, index, images, "", "")
  })
  return { images, turns }
}

function onlyToolResults(content) {
  return Array.isArray(content) && content.length > 0 && content.every((p) => p?.type === "tool_result")
}

function walkAnthropic(list, index, images, tool, path) {
  list.forEach((part, at) => {
    if (!part || typeof part !== "object") return
    if (part.type === "tool_result" && Array.isArray(part.content)) {
      walkAnthropic(part.content, index, images, "tool_result", path)
      return
    }
    if (part.type !== "image" || !part.source || part.source.type !== "base64" || typeof part.source.data !== "string") return
    const mime = part.source.media_type || ""
    images.push({
      index, kind: tool ? "tool" : "attachment", tool: tool === "tool_result" ? "" : tool, path, mime,
      bytes: part.source.data.length, dataUrl: `data:${mime || "image/png"};base64,${part.source.data}`,
      set: (text) => { list[at] = { type: "text", text } },
    })
  })
}

function collectChat(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const images = []
  const turns = []
  msgs.forEach((m, index) => {
    if (m?.role === "user") turns.push(index)
    const list = Array.isArray(m?.content) ? m.content : null
    if (!list) return
    list.forEach((part, at) => {
      const url = part?.type === "image_url" ? (typeof part.image_url === "string" ? part.image_url : part.image_url?.url) : null
      if (typeof url !== "string" || !url.startsWith("data:")) return
      images.push({
        index, kind: "attachment", tool: "", path: "", mime: mimeOf(url),
        bytes: url.length, dataUrl: url,
        set: (text) => { list[at] = { type: "text", text } },
      })
    })
  })
  return { images, turns }
}

function collectGemini(body) {
  const contents = Array.isArray(body.contents) ? body.contents : []
  const images = []
  const turns = []
  contents.forEach((c, index) => {
    const parts = Array.isArray(c?.parts) ? c.parts : null
    if (!parts) return
    if (c?.role === "user" && parts.some((p) => p && !p.functionResponse && !p.function_response)) turns.push(index)
    parts.forEach((part, at) => {
      const inline = part?.inlineData || part?.inline_data
      if (!inline || typeof inline.data !== "string") return
      const mime = inline.mimeType || inline.mime_type || "image/png"
      images.push({
        index, kind: "attachment", tool: "", path: "", mime,
        bytes: inline.data.length, dataUrl: `data:${mime};base64,${inline.data}`,
        set: (text) => { parts[at] = { text } },
      })
    })
  })
  return { images, turns }
}

function pathOf(call) {
  if (!call) return ""
  let args = call.arguments
  if (typeof args === "string") {
    try { args = JSON.parse(args) } catch { return "" }
  }
  if (!args || typeof args !== "object") return ""
  for (const key of ["path", "file_path", "image_path", "screenshot_path", "filename", "file"]) {
    if (typeof args[key] === "string" && args[key]) return args[key]
  }
  return ""
}

function placeholder(o, img) {
  const path = img.path
  if (o.placeholder) {
    return o.placeholder
      .replaceAll("{kind}", img.kind)
      .replaceAll("{tool}", img.tool)
      .replaceAll("{path}", path)
      .replaceAll("{mb}", mb(img.bytes))
      .replaceAll("{mime}", img.mime)
      .replaceAll("{id}", id(img))
  }
  const what = img.tool ? `a ${img.tool} result` : img.kind === "tool" ? "an image a tool returned" : "an image the user attached"
  const where = path
    ? ` It is the file ${path}; call view_image on that path if you need to look at it again.`
    : " If you need it again, ask the user to attach it once more."
  return `[${mb(img.bytes)} MB image left out here: ${what}, already seen earlier in this conversation. ` +
    `Rely on what you already said about it.${where}]`
}

// id is a short stable name for an image, so a placeholder can point at the
// same picture twice without repeating the bytes.
function id(img) {
  const at = img.dataUrl.indexOf("base64,")
  return hash(at < 0 ? img.dataUrl : img.dataUrl.slice(at + 7, at + 7 + 4096))
}

// hash is FNV-1a, 32 bits, hex. A middleware may not import node:crypto.
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

function isDataUrlPart(part, type, key) {
  return !!part && part.type === type && typeof part[key] === "string" && part[key].startsWith("data:")
}

function mimeOf(url) {
  const m = /^data:([^;,]+)/.exec(url)
  return m ? m[1].toLowerCase() : ""
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(2)
}

// Tests use these; magpie never calls them.
export const _internal = { options, collect, keepSet, turnStart, placeholder, pathOf, hash }
