# Meme Engine backend (`memeEngine_be`)

NestJS + `@napi-rs/canvas` + MongoDB. Turns three inputs (a viral meme screenshot, your reaction
image, your exact punchline) into a finished meme (1080x1350 by default) in your page's style.

## Run

```bash
npm install
npm run build      # TypeScript -> dist/
npm start          # http://127.0.0.1:3000
# or: npm run start:dev   (build + start)
```

Needs MongoDB at `mongodb://127.0.0.1:27017/kanyaraasi_memes` and the Antigravity CLI (`agy`)
signed in once (run `agy` in a terminal). Settings: copy `.env.example` to `.env`.
`npx ts-node src/main.ts` no longer works (ts-node does not support the installed TypeScript 7).

## Viral adaptation pipeline (`POST /api/memes/adapt-viral`)

| Step | Who | What |
|---|---|---|
| 1 Reference analysis | vision model (sandboxed) | per-slot structure, subjects, context, text; reaction panel and its punchline ignored |
| 2 Identity | code | whole-phrase names, verified aliases, Telugu names, film characters, AI identification only above a confidence threshold; ambiguous = stop and explain |
| 3 Content | code | reference headline/labels/bullets + **your exact punchline** (never rewritten) |
| 4 Design + layout | code | your saved Settings (house style); deterministic layout from the reference's relative structure |
| 5 Discovery | code + vision model | internet only: grounded queries, providers, ranking, safe downloads, duplicate checks, visual verification |
| 6 Render | canvas | text fitting (never truncates), focal-point cropping, structural output checks |

Every meme stores a **generation report** (analysis, identity decisions, queries, candidates,
rejections with reasons, licences, timings): `GET /api/memes/:id/report`.

### Running it in the background, with live progress

The app does not wait on one long request. It starts the same pipeline as a job and watches it:

| Endpoint | Purpose |
|---|---|
| `POST /api/memes/adapt-viral/jobs` | same multipart body and validation as `adapt-viral`; answers `202` at once with the job (`429` if one is already running) |
| `GET /api/memes/adapt-viral/jobs/:jobId` | the job now: `status` (`running` / `done` / `failed`), `elapsedMs`, the four `stages` (`analysis`, `identity`, `discovery`, `render`) with their state and a note, each picture `slot` with its own state, a short `log`, and when finished the `result` (the same body `adapt-viral` returns) or the `error` (the same `message` and `details`) |
| `GET /api/memes/adapt-viral/jobs/active` | `{ job }`: the one still running, so a refreshed page or another device can pick it up |

Progress is reported by the pipeline itself at each real boundary (a stage began, a picture was found for slot 2:
counts and a provider name, never titles or links), not estimated. Jobs live in memory for 30 minutes after they
finish; a server restart loses only the progress view, never a finished meme (it is saved by the pipeline).
`POST /api/memes/adapt-viral` still works unchanged (one long request), and the WhatsApp bot calls the pipeline
directly, so neither is affected.

## Settings (`/api/settings`, frontend `/settings`)

One record in the existing `design_profiles` collection (`profileId: kanyaraasi-default`) holds
the settings: `settings` stores only the values that differ from the defaults, and `profile` keeps
the older flat profile in sync (`GET/PUT /api/design-profile`, `POST /api/design-profile/reset`
still work and map onto the settings). A record holding only an older profile is migrated on read.

| Endpoint | Purpose |
|---|---|
| `GET /api/settings` | settings, defaults, allowed ranges (schema), installed fonts, effective pipeline values, provider availability and monthly usage (no keys) |
| `PUT /api/settings` | partial update; every value is validated (unknown keys, fonts, ranges, min/max sizes) and nothing is saved if one is invalid |
| `POST /api/settings/reset` | `{ "section": "typography" \| "effects" \| "canvas" \| "imageProcessing" \| "discovery" \| "advanced" \| "all" }` |
| `POST /api/settings/preview` | renders a sample meme with unsaved settings through the real layout engine and renderer; in memory only (no record, no file) |

Sections: typography and text effects per text role (heading, subject labels, supporting text,
punchline, captions), canvas and layout, image processing, image discovery, advanced.

- **Visual settings** are copied into each new meme (`design.style`). Existing memes and their
  versions keep the style they were made with; regeneration re-renders a meme with its own copy.
  Memes made before Settings existed have no copy and render with the original constants
  (pixel-identical).
- **Pipeline settings** (providers, rights policy, search effort, thresholds, timeouts, limits,
  diagnostics, log level) apply at once on top of `.env`. They can only switch providers off, raise
  thresholds or lower limits; keys and monthly caps stay in `.env`.

## Reaction library (`/api/reactions`, frontend `/reactions`)

The owner's own reaction pictures, filed in free-form folders ("shocking", "sad funny", "brahmi laughing"...) with optional tags, so one can be picked in a tap instead of being found and uploaded every time. Pictures are stored **in MongoDB** (collection `reaction_images`: the original bytes plus a 480 px copy), not on disk, so they survive redeploys on hosts with a temporary disk such as Render's free plan. The same file is never stored twice (SHA-256), pictures larger than 2400 px or 3 MB are shrunk when stored, and at most 3000 are kept.

| Route | What |
|---|---|
| `GET /api/reactions?category=&search=&sort=newest\|recent\|used&limit=&skip=` | a page of summaries (never image bytes) |
| `GET /api/reactions/categories` | folders with counts |
| `POST /api/reactions` | multipart: `images` (up to 12) + `category` (+ `tags`); per-file results `added` / `duplicates` / `failed` |
| `PATCH /api/reactions/:id`, `DELETE /api/reactions/:id`, `POST /api/reactions/bulk` | edit folder / name / tags; move or delete many |
| `GET /api/reactions/:id/thumb`, `/:id/file` | bytes, cacheable (a picture never changes) |
| `POST /api/reactions/:id/used` | counts a use (what the quick-pick row sorts by) |

Every route needs the sign-in session. Generation itself is unchanged: the frontend downloads the chosen picture and sends it as the normal `reactionImage` upload.

### Reaction framing (`services/reaction-framing.ts`)

Reaction pictures are often two or three movie frames stacked on top of each other. A plain cover crop of a square stack keeps a middle band: one face cut at the chin, the next at the eyes. So the renderer first looks at the picture (about 2 ms): it finds the seams between stacked frames (a dark divider, or a hard cut near an even split; edge bars and horizons are not taken for frames) and a face in each frame (skin colour, biggest compact patch high in the frame), then shows the frames **side by side** in the panel, each cropped around its face. An ordinary single picture takes the unchanged crop, byte for byte.

The owner chooses per meme with `reactionFraming`: `{ "split": true }` (frames side by side), `{ "frame": 0 }` (only that frame, 0 is the top one, filling the panel), `{ "fit": "whole" }` (the entire picture, uncropped, on a softened darkened copy of itself), `{ "split": false }` (one scene, the old crop), each optionally with `"focus": [{ "x": 0..1, "y": 0..1 }]` to move what shows (a form field of `POST /api/memes/adapt-viral`, or `design.reactionFraming` of `upload-and-generate`). It is stored in the meme's design and kept through regeneration. `POST /api/reactions/analyze` (one `image`, nothing stored) returns the frames, suggested focus and the panel's shape for the studio's live preview. Settings → Images → Reaction fit `contain` bypasses all of this.

## WhatsApp bot: the same flow as the studio

The bot walks the same steps as the app: reference screenshot, reaction image, punchline, review, *Approve* to publish. The reaction library and the frame question are in it too:

- **Library.** While it waits for the reaction image (or the punchline), send `Library`: it lists your folders with counts (`0` is *recently used*). Reply a number or a folder name, or type words to search folders, names and tags (`library brahmanandam`). A folder opens as one **numbered picture sheet** (12 per page; `More` / `Previous` / `Back` / `Close`); reply the number to use that picture. A picture sent by hand works as before.
- **Which frame?** A reaction picture made of stacked frames is never decided silently. The bot sends one image showing every choice, then a tap-list (plain numbered text if a list cannot be sent): `1` both frames side by side, `2`/`3` each frame alone, then the whole picture, then one picture (cropped). Words work too (`both`, `first`, `top`, `whole`). Nothing is generated until it is answered; the choice goes to the meme exactly like the studio's (`reactionFraming`). A small picture gets the same "will look soft" warning. The manual flow asks too.
- Library pictures are counted as used when the meme is made, so the studio's quick-pick row learns them. `Status` shows where the picture came from and the framing; `Reset` forgets everything.
- **Pictures are uploaded to WhatsApp** (Cloud API media upload, then sent by media id), so a finished meme or a sheet arrives whatever the server's public address is. Only if the upload fails is the picture sent as a link to `PUBLIC_BASE_URL`, which WhatsApp must then be able to download. Meta accepts such a link and fails later, so the bot also listens to delivery-status webhooks: a failed delivery is logged with Meta's reason, and when a picture could not be loaded the user is told once (look in *My Memes*) instead of getting nothing.
- Picture sheets are also written to the output folder as `wa_sheet_*.jpg` (older than 6 hours are removed), for the link fallback.
- Code: `services/whatsapp.service.ts` (conversation), `services/whatsapp-reaction-ui.ts` (sheets, choices, answers; pure and tested).

### Reliability: one line per person, one run per meme

- **Messages are handled in the order they were sent, one at a time per person.** Meta delivers messages in separate requests that can overlap; handled at once, several photos sent together were saved in the order they finished downloading and two replies could overwrite each other's changes. Each person now has a line (`inLane`).
- **A meme being made does not freeze the chat.** The line is released when a generation starts, so `Status`, `Reset` and any other message are answered meanwhile (`Status` shows the elapsed time and what the engine is doing). Each person has at most one run (`runs`, in memory): `Reset`/`Discard` cancels it, and a result that arrives after that is saved in the studio but never delivered into the fresh chat.
- **Progress is told as it happens**, from the pipeline's real stages (who was identified, each picture as it is found, "setting your punchline"), always before the meme itself. After 75 s of quiet it says it is still working, and the typing indicator is refreshed every 20 s (`status: read` + `typing_indicator`, best effort).
- **A restart or a failure never leaves the chat stuck.** A session found in `GENERATING` with no run in memory (the server restarted) is detected on the next message and moved to `AWAITING_RETRY`; a failed generation also goes there, with every input kept. `Retry` runs it again; any other text is taken as a new punchline and runs it with that. (A restart-notice message is not itself mistaken for a punchline.)
- **No dead ends.** A message with no meaning in the current state (free text under a finished meme, a picture while busy, a voice note) is answered with where things stand and what to do next. Emoji reactions to a message are ignored on purpose.

### Under a finished meme

The review message is the meme with three reply buttons: **Publish**, **Change punchline**, **Discard** (WhatsApp allows three buttons of up to 20 characters under a picture; if they cannot be sent, the old picture-with-commands message is used). Button ids carry the meme (`pub:<id>`, `pl:<id>`, `no:<id>`), so a tap on an older meme's buttons never acts on a newer one.

- **Only `Approve`, `Publish` or the Publish button publish.** A casual `ok`, `yes` or 👍 never posts to Instagram: it is answered with how to publish.
- **Change punchline** asks for the owner's own new words and re-renders the same pictures and style as the meme's next version (`MemeEngineService.changePunchline`: the words are only trimmed; older versions are never touched). `Cancel` goes back to the meme.
- **Caption.** The Instagram caption is built like the studio's (`services/instagram-caption.ts`: punchline, headline, topic, follow line, hashtags, within 2200 characters). `Caption: your text` replaces it; swapping a picture keeps an own caption.

## Emoji in meme text

The server draws the text, so emoji must not depend on the machine having an emoji font (flags came out as the letters "IN", recent emoji as empty boxes, and a Linux host without an emoji font drew none). `fonts/NotoColorEmoji.ttf` (Google's Noto Color Emoji, SIL Open Font License; notice in `fonts/NotoColorEmoji.NOTICE.txt`) is registered with the other fonts and sits last in every font stack (`CanvasRendererService.fontFor`), so it only draws characters the meme fonts do not have: letters, digits, symbols and Telugu are drawn exactly as before. It is a 25 MB file, so the fonts folder must be part of what you deploy (it already has to be). Not offered as a choice in Settings. `tests/emoji.test.ts` draws real emoji through the renderer and looks for colours only a real emoji glyph produces.

## Manual memes in the studio: live preview

`POST /api/memes/upload-and-preview` takes exactly the body of `upload-and-generate` and answers `{ image, width, height }`: the meme laid out and rendered as it will be, **in memory**. No record is saved, no file is kept (the uploaded copies are deleted whatever happens), so trying a change leaves nothing in My Memes. At most two previews are drawn at once (`429` otherwise). The Create page redraws it a moment after you stop typing, sending the pictures at preview size (same proportions), and shows what the engine objects to (a headline that cannot fit) before you press Generate.

## Replacing images (no manual editor)

| Endpoint | Purpose |
|---|---|
| `POST /api/staged-images/upload` | your own picture (multipart `image`): checked by content, previewed, kept in memory for 15 min |
| `POST /api/staged-images/search` | `{ query }`: searches through the enabled providers (their monthly caps apply), downloads results safely, returns previews |
| `DELETE /api/staged-images/:token` | cancel a choice |
| `POST /api/memes/:id/slots/:slot/candidates` | pictures found during the original discovery (the AI's first pick and its verified alternates) |
| `POST /api/memes/:id/image-replace/preview` | `{ changes: [{ slot, token }] }` renders the whole meme in memory |
| `POST /api/memes/:id/image-replace` | applies the change: only those images change (layout, text, punchline, reaction image and styling are reused) and a new version is created with an `imageChanges` record |
| `POST /api/memes/viral-analyze` | optional first step of viral adaptation: analyses the reference once and returns its image slots; `adapt-viral` then accepts `draftId` + `slotOverrides` and does not analyse again |

A picture you choose is recorded as yours (`sourceType`: `user_upload` / `online_search`,
`selectedBy: user`, `aiVerified: false`): it gets technical validation (real image, size, decodes) but
no identity check, and the AI regeneration never replaces it. Earlier versions are never modified.

## Security model (summary)

- The vision CLI runs without `--dangerously-skip-permissions`, with an isolated per-run profile
  (your CLI plugins and global permissions are not loaded), commands/URLs/MCP/writes denied, and
  file reads confined to a per-run folder holding only the images. Text inside screenshots is
  treated as data; every answer must echo a random code drawn on the image.
- Outbound HTTP refuses private/loopback/metadata addresses (checked at connection time), caps size
  and time, and re-validates redirects. Uploads are checked by content; uploads are not public.
- The API listens on 127.0.0.1 and refuses foreign Host/Origin headers.
- Every route needs a signed-in session (see **Login**). Only these are public, and each protects itself:
  `GET /api/health`, `/api/auth/me|login|logout`, the WhatsApp webhook (Meta signature / verify token) and
  the Instagram OAuth callback (`state`). Generated memes under `/output/` stay public on purpose (Meta
  fetches them); their names contain a random UUID and only `.png/.jpg` is served.

## Login

One owner account, signed in with a username (or e-mail) and password. There is no sign-up page: the owner
is created from the command line, on the machine that runs the server.

```bash
npm run build
npm run auth:create-owner     # asks for username + password (typed hidden)
npm start                     # then open the studio and sign in
npm run auth:reset-password   # forgot it: sets a new one and signs out every device
npm run auth:status           # is an owner set up?
```

How it works: passwords are hashed with scrypt (salted, memory-hard); a sign-in creates a server-side session
whose random token lives in an `HttpOnly`, `SameSite=Lax` cookie (`__Host-` prefixed and `Secure` on HTTPS) and
only its SHA-256 is stored; sessions end after 7 idle days or 30 days total, on sign-out, or when the password
changes. Wrong passwords are limited per username+address (5, then a 15-minute lock), per address, and per
username overall; real and unknown usernames behave identically. On top of the Origin allow-list, a
state-changing request the browser labels cross-site is refused.

| `.env` setting | Default | Meaning |
|---|---|---|
| `AUTH_ENABLED` | `true` | `false` turns login off. The server refuses to start that way if it is reachable from outside. |
| `APP_PUBLIC_URL` | `http://localhost:5173` | Where the browser opens the studio (the Instagram OAuth callback returns here). |
| `APP_HOSTS` | empty | Host names that serve the whole app behind login (hosting). |
| `TRUST_PROXY` | `0` | Reverse proxies in front of the server (`1` behind Caddy/nginx). |
| `AUTH_COOKIE_SECURE` | `true` if `APP_PUBLIC_URL` is https | Send the cookie over HTTPS only. |
| `AUTH_SESSION_IDLE_DAYS` / `AUTH_SESSION_MAX_DAYS` | `7` / `30` | Session lifetime. |
| `AUTH_MAX_FAILURES` / `AUTH_LOCK_MINUTES` | `5` / `15` | Wrong-password limit and lock time. |

**Sign in with WhatsApp.** When the WhatsApp bot is set up (access token, phone number ID, app secret and at least
one allowed number), the sign-in page offers a second way in: it shows a one-time 6-digit code, a QR code (on a
computer) or a "Send code on WhatsApp" button (on a phone) that opens WhatsApp with `Login 482915` already typed.
Send it from an allowed number and the page opens the studio by itself, usually within a second.

- What proves it is you is the sender: only the allowed numbers can approve a code, and the webhook only accepts
  messages Meta signed with the app secret. The page waits with a secret token, never with the code, so a code seen
  on someone's screen is useless to anyone else. Codes work once and last 5 minutes; a page being looked at gets a
  fresh one by itself. New codes are limited per address (12 per 10 minutes) and overall (100 waiting).
- The bot answers with the device and address that asked for the code and a **That wasn't me** button that ends
  exactly that sign-in. Sending **Sign out everywhere** to the bot ends every sign-in and every waiting code.
- A code sent from a number that is not allowed approves nothing; the waiting page says which number (last 4 digits)
  it came from. Bare digits only count as a sign-in when they match a code that was handed out, so the meme chat is
  never interrupted.
- It signs in the owner account (the static login if set, otherwise the account created first) and shows up under
  Account › Sessions as "WhatsApp · 8120". Password sign-in keeps working on its own tab.
- Codes live in the server's memory: after a restart the page simply gets a new code.

| `.env` setting | Default | Meaning |
|---|---|---|
| `AUTH_WHATSAPP_LOGIN` | `true` | `false` hides WhatsApp sign-in (password only). |
| `WHATSAPP_DISPLAY_PHONE` | asked from Meta | The bot's number shown on the sign-in page, e.g. `+91 90000 11111`. |

**New sign-in alerts.** Every sign-in (password or WhatsApp code) is sent to the allowed WhatsApp numbers and to
devices with notifications on: device, address and how, with a **That wasn't me** button that ends exactly that
session. Sign-in paused after wrong passwords is reported too. WhatsApp delivers these only within 24 hours of your
last message to the bot, unless an approved template is set (`WHATSAPP_ALERT_TEMPLATE`, body variables device /
address / how, one quick-reply button). `AUTH_SIGNIN_ALERTS=false` turns them off.

**Notifications (Web Push).** Settings › Notifications turns them on per device: "meme ready / failed" (with the meme
as a picture) and "new sign-ins". The server signs with a VAPID key pair (made once and stored encrypted, or
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`); only the push services browsers use are accepted as addresses; a device that
signs out stops receiving. iPhone: only from the studio added to the Home Screen. While a meme is made the browser
tab shows a progress ring and "62% · …" in its title.

**Health.** `/health` in the studio (`GET /api/system/health`, `?live=1` also asks Meta) checks the database, disk,
sign-in setup, WhatsApp token / allowed numbers / incoming webhooks / delivery failures, Instagram, the public address,
AI vision, image sources and quotas, and notifications, each with what to do about it.

**Temporary static login.** `AUTH_STATIC_USERNAME` + `AUTH_STATIC_PASSWORD` define a fixed login straight from the
environment, so there is nothing to run (useful on a host without a shell). The account is created or updated at
every start; changing the password in the environment and restarting replaces it and signs everyone out. The
password is stored hashed in the database but sits in plain text in `.env` / the host's settings, may be as weak as
you like, and cannot be changed from the Account page. The app shows a "Temporary login" reminder while it is in
use. **Anyone who knows the address and these two values can sign in** (and publish to Instagram, delete memes, use
your paid search quotas). To replace it with a private password: delete both settings and run
`npm run auth:create-owner`.

Running it on a public address: see [DEPLOY.md](DEPLOY.md).

## Tests

| Command | Kind | Needs |
|---|---|---|
| `npm test` | offline unit + mocked pipeline tests | nothing |
| `MONGO_TEST_URI=mongodb://127.0.0.1:27999/meme_test npm run test:integration` | integration | a scratch MongoDB |
| `npm run live:analyze -- <image>` | LIVE vision analysis | agy signed in |
| `npm run live:viral -- --base http://127.0.0.1:3000 --reference <ref> --reaction <img> --punchline "..."` | LIVE end-to-end | running server, agy, internet, `SESSION_COOKIE="me_session=..."` (copy it from the browser) |
| `npm run live:regenerate -- --meme <id> --instruction "..."` | LIVE regeneration | running server, agy, `SESSION_COOKIE` as above |
| `test-security-e2e.js` | attack suite against a scratch server (started with `AUTH_ENABLED=false`) | see the file header |

## Image sources, rights and provider terms

**Rights policy** (`DISCOVERY_RIGHTS_POLICY`, default `allow_copyrighted`): copyrighted images
(film stills, studio promotional images, celebrity, news and editorial photos) may be discovered and
used. Every selected image carries a rights record (`asset.rights`, and `rights` in the generation
report) with one of three labels:

| Label | Meaning |
|---|---|
| `open_license` | public domain, CC0, CC BY, CC BY-SA, GFDL ... (credit / share-alike conditions recorded) |
| `open_license_restricted` | an open licence that does not cover this use (NonCommercial, NoDerivatives) |
| `copyrighted_unconfirmed` | everything else, or no licence information: reuse permission NOT confirmed |

`open_license_only` restricts discovery to the first class. Identity, visual verification, relevance
and quality checks are identical in both modes; rights never change the ranking.

**Providers**

| Provider | Finds | Needs | Storage under its terms |
|---|---|---|---|
| Wikimedia Commons, Wikipedia, Openverse | licensed portraits and event photos; Wikipedia's non-free film posters (labelled copyrighted) | nothing | stored |
| Google Cloud Vision reverse image search | the exact underlying picture of each reference slot, and the pages carrying it | `GOOGLE_CLOUD_VISION_API_KEY`; capped at 1000/month (the free tier) | stored |
| Brave Image Search | web images by text (stills, promotional and news photos) | `BRAVE_SEARCH_API_KEY`; capped at 1000/month (about the free credit) | used during the run only: titles and links are never stored |
| TMDB | film backdrops, posters, actor photos | a key AND `TMDB_COMMERCIAL_AGREEMENT=true` (a written agreement; the standard terms forbid AI-based and derivative use) | per agreement |
| Google Programmable Search | web images | existing keys only; ends 2027-01-01 | run only |
| DuckDuckGo (unofficial) | web images | `DISCOVERY_ALLOW_UNOFFICIAL=true` | run only |

Paid providers are capped per calendar month (MongoDB collection `provider_usage`): requests stop at
the cap and the report says so. `GET /api/system/status` shows this month's usage. Only the subject
slot's crop is sent to reverse image search (never the reaction image or the punchline).

**Reference match**: among verified candidates, clean pictures come first, then the exact underlying
picture of the reference, then the same scene, then the best score. It is a preference only; the
acceptance rules do not change.
