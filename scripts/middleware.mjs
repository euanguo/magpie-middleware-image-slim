// Runs a gateway middleware's cases the way magpie's gateway calls it: one
// ctx for the request's hooks (so ctx.state carries over), each body a fresh
// copy of its JSON, undefined keeping what came in, null dropping an event.
// The same cases.json runs in magpie's own JavaScript engine (moejs), so a
// middleware is checked in both.
//
// From magpie-community/plugins (MIT), scripts/middleware.mjs, kept in step by hand.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"

export function cases(dir) {
  return JSON.parse(readFileSync(join(dir, "cases.json"), "utf8"))
}

export async function run(mod, c) {
  const m = mod.default ?? mod
  let rejected
  const ctx = {
    protocol: "anthropic", model: "", stream: false, path: "", ...c.ctx,
    options: c.options ?? {}, state: {},
    reject(status, message) { rejected ??= { status, message } },
  }
  const copy = (v) => JSON.parse(JSON.stringify(v))
  const out = {}
  if (c.request) {
    const r = m.onRequest ? await m.onRequest(copy(c.request), ctx) : undefined
    if (rejected) out.reject = rejected
    else out.request = r === undefined ? c.request : copy(r)
  }
  if (c.events) {
    out.events = []
    for (const e of c.events) {
      const wants = !m.events || (e.event && m.events.includes(e.event))
      if (typeof e.data !== "object" || !m.onEvent || !wants) {
        out.events.push(e.data)
        continue
      }
      const r = await m.onEvent(copy(e.data), ctx)
      if (r === null) continue
      out.events.push(r === undefined ? e.data : copy(r))
    }
  }
  if (c.response) {
    ctx.status = c.status ?? 200
    const r = m.onResponse ? await m.onResponse(copy(c.response), ctx) : undefined
    out.response = r === undefined ? c.response : copy(r)
  }
  return out
}

// check runs each case and compares it with what it expects: a request,
// events or response not expected are expected to pass unchanged.
export function check(dir, mod) {
  for (const c of cases(dir)) {
    test(c.name, async () => {
      const got = await run(mod, c)
      if (c.reject) {
        expect(got.reject?.status).toBe(c.reject.status)
        if (c.reject.message) expect(got.reject?.message).toContain(c.reject.message)
      } else {
        expect(got.reject).toBeUndefined()
        if (c.request) expect(got.request).toEqual(c.expect_request ?? c.request)
      }
      if (c.events) expect(got.events).toEqual(c.expect_events ?? c.events.map((e) => e.data))
      if (c.response) expect(got.response).toEqual(c.expect_response ?? c.response)
    })
  }
}
