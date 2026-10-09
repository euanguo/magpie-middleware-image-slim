import * as mod from "./image-slim.middleware.js"
import { check } from "./scripts/middleware.mjs"

// cases.json is run the way magpie's gateway calls the hooks: one ctx per
// request, each body a fresh copy, undefined meaning "send it as it came".
check(import.meta.dir, mod)
