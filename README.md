# magpie-middleware-image-slim

Keep the newest images in a conversation and replace older inline images with a
short text placeholder, as [magpie](https://usemagpie.ai) gateway middleware.

Agents resend **every image in a conversation on every turn**. Codex sends the
whole transcript to a stateless provider and the images in it are inline
base64, so a thread with a few dozen screenshots uploads tens of megabytes per
request even when the turn is pure text. This middleware keeps the newest
images and swaps the older ones for a short placeholder, so those bytes never
leave the machine.

Measured on a Mac mini (codex-cli 0.160.0 through magpie, request bodies read
at a local proxy):

| Request | Body |
| --- | ---: |
| text only | 43 KB |
| 1 screenshot | 4.88 MB |
| the next turn, text only, no new image | 4.88 MB — the same screenshot again |
| 3 screenshots in one turn | 12.86 MB |
| 12 screenshots in the history | 55.32 MB |

The same 12-screenshot request through magpie with this middleware on:
**55.32 MB → 9.23 MB**, ten images replaced by placeholders, the newest two
kept inline.

## Install

```sh
magpie plugin add euanguo/magpie-middleware-image-slim
magpie plugin options image-slim '{"keep_last":2}'
magpie plugin            # gateway middleware  onRequest
```

In the app it is under **Plugins**, with its options on its row. Turn it off or
remove it at any time; nothing else is touched:

```sh
magpie plugin off image-slim
magpie plugin rm image-slim
```

## Options

Defaults are the `magpie.options` in `package.json`. Set yours under
**Plugins › Installed › Options**, or with `magpie plugin options image-slim '<json>'`.

| Option | Default | Meaning |
| --- | --- | --- |
| `keep_last` | `2` | How many of the newest images stay inline. `0` keeps only the turn being sent. |
| `keep_current_turn` | `true` | Never touch images from the turn being sent. |
| `min_bytes` | `8192` | Leave images smaller than this alone (base64 payload size). |
| `attachments` | `true` | Also slim images the user pasted or attached. |
| `tools` | `[]` | Only slim these tools' results, e.g. `["view_image"]`. `[]` means every tool. |
| `agents` | `[]` | Only these agents, e.g. `["codex"]`. `[]` means every agent. |
| `models` | `[]` | Only these models. `[]` means every model. |
| `placeholder` | `""` | Your own wording; `""` uses the built-in sentence. |
| `log` | `true` | Write what was left out to magpie's log, as `plugin: image-slim: …`. |

The placeholder template takes `{kind}` (`tool` / `attachment`), `{tool}`,
`{path}`, `{mb}`, `{mime}` and `{id}`:

```json
{ "keep_last": 1,
  "placeholder": "[screenshot left out: {mb} MB, file {path} — view_image it again if needed]" }
```

## Reading an image back

A placeholder names the file the image came from, so an agent can look again
when it really needs to. The tool call that produced the image is still in the
request and its arguments carry the path:

```
[4.61 MB image left out here: a view_image result, already seen earlier in this
conversation. Rely on what you already said about it. It is the file
/tmp/shot0.png; call view_image on that path if you need to look at it again.]
```

An image the user pasted has no path to name, so its placeholder says so and
suggests asking the user to attach it once more.

## What it reads

Every content shape an agent sends, in all four APIs magpie serves:

| API | Where images live |
| --- | --- |
| OpenAI Responses (Codex) | `input[].content[].input_image`, and `input[].output[].input_image` for tool results |
| Anthropic Messages (Claude Code) | `messages[].content[].image`, and images inside `tool_result.content[]` |
| Chat Completions | `messages[].content[].image_url` |
| Gemini | `contents[].parts[].inlineData` |

Anything else is left exactly as it came, and a request with no image is not
touched at all. If the middleware itself throws, magpie sends the request on
unchanged. A tool result is replaced with a plain string, which every
Responses-compatible server accepts.

## Notes

- A middleware may import only files beside it, so this is one plain
  JavaScript file: no `node:` modules, no dependencies.
- Replacing an old image shifts the prompt prefix once, when that image first
  ages out. The placeholder is stable text after that, so the prefix settles.
- The upstream model really does stop seeing the older images. Everything it
  said about them stays in the conversation, and it can read one back by path.
  `keep_last` is the dial between bandwidth and how much of the recent visual
  history the model still has.

## Development

```sh
bun test              # cases.json, run the way magpie's gateway calls the hooks
scripts/try.sh        # load it into a sandboxed magpie (.sandbox/), never yours
```

`cases.json` holds one case per behaviour and runs through `scripts/middleware.mjs`,
the same runner magpie's community plugins use, so a case also runs in magpie's
own JavaScript engine.

## Related

Upstream, all still open: [openai/codex#35732](https://github.com/openai/codex/issues/35732)
(historical images re-uploaded on every turn), [#46761](https://github.com/openai/codex/issues/46761)
(99.6% of the history is base64 images), [#45971](https://github.com/openai/codex/issues/45971)
(hundreds of GB a month from one workstation), [#33760](https://github.com/openai/codex/issues/33760),
[#23257](https://github.com/openai/codex/issues/23257) (compaction copies the same images
again and again), [#37194](https://github.com/openai/codex/issues/37194).

Others in the same space: [Codex Attachment Manager](https://github.com/chipfighter/codex-attachment-manager)
(a Codex desktop plugin, official backend only) and
[image-context-cascade](https://github.com/dlgod7/image-context-cascade) (rewrites the
session file). This one runs in magpie's gateway, so it works for every agent and
every provider, and needs no config change anywhere.

中文：把对话里较早的内联图片换成一句带本地路径的占位符，只保留最近 N 张，让每一轮不再重传全部截图。装在 magpie 网关里，所有 agent、所有供应商都生效；模型需要时可以用 `view_image` 按占位符里的路径把图读回来。

## License

MIT
