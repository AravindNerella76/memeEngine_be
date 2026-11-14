# Running the studio on a public address

Login protects the studio; this page is the rest of what a public site needs. Read **What is not covered**
first: one prerequisite (the AI vision tool) is outside the login work and decides whether hosting is possible
at all.

## Shape

```
Internet ──HTTPS──▶ Caddy (or nginx)
                      ├─ /            → memeEngine_fe/dist   (static files)
                      └─ /api, /output → http://127.0.0.1:3000 (this backend)
                                            └─ MongoDB on 127.0.0.1 only
```

The browser talks to **one address**. That keeps the session cookie first-party, needs no CORS, and is why the
frontend's API base now defaults to "same address as the page".

## 1. Backend `.env`

```ini
HOST=127.0.0.1                         # stay on loopback; the proxy faces the internet
APP_HOSTS=studio.example.com           # the whole app is served here, behind login
APP_PUBLIC_URL=https://studio.example.com
TRUST_PROXY=1                          # one proxy in front: real client addresses for the sign-in limits
PUBLIC_BASE_URL=https://studio.example.com
INSTAGRAM_REDIRECT_URI=https://studio.example.com/api/instagram/auth/callback
# keep your existing META_*, WHATSAPP_*, MONGO_URI, INSTAGRAM_TOKEN_ENCRYPTION_KEY ...
```

Create the owner on the server, then start it:

```bash
npm ci && npm run build
npm run auth:create-owner
npm start            # run under a process manager (pm2, systemd, a Windows service) so it restarts
```

The server prints a warning at start if `APP_HOSTS` is set without `TRUST_PROXY`, or the cookie is not `Secure`,
and refuses to start at all if login is off while it is reachable from outside.

## 2. Frontend

```bash
cd memeEngine_fe && npm ci && npm run build      # leave VITE_API_BASE unset
```

Serve `memeEngine_fe/dist` from the proxy, with every unknown path falling back to `index.html` (the app has
client-side routes such as `/memes` and `/meme/<id>`).

## 3. Caddy (HTTPS and certificates are automatic)

```caddyfile
studio.example.com {
    encode gzip
    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle /output/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        root * /srv/memeEngine_fe/dist
        try_files {path} /index.html
        file_server
    }
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        X-Frame-Options "DENY"
        Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; frame-ancestors 'none'"
    }
    request_body {
        max_size 25MB
    }
}
```

**nginx instead?** A meme takes 2–4 minutes and the browser waits on one request, so raise the read timeout
(nginx's default of 60 s would cut every generation off):

```nginx
location /api/ { proxy_pass http://127.0.0.1:3000; proxy_read_timeout 600s; client_max_body_size 25m;
                 proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr;
                 proxy_set_header X-Forwarded-Proto $scheme; }
```

Do not put a service in front that caps a request at ~100 s (some CDN plans do) without raising it.

## 4. Meta (Instagram and WhatsApp)

The public host replaces ngrok. In the Meta developer dashboard set:

- Valid OAuth redirect URI: `https://studio.example.com/api/instagram/auth/callback`
- App domain: `studio.example.com`
- WhatsApp webhook callback URL: `https://studio.example.com/api/whatsapp/webhook` (verify token unchanged)

Those two paths stay reachable without a session on purpose, and each checks itself (OAuth `state`, Meta's
`X-Hub-Signature-256` HMAC). Everything else on the public host needs the owner's sign-in.

## 5. Checklist before you tell anyone the address

- [ ] `https://studio.example.com/api/memes` answers **401** in a private window (not data, not 403).
- [ ] `https://studio.example.com/` shows the sign-in page; a wrong password gives one generic message.
- [ ] Browser dev tools → Application → Cookies: `__Host-me_session` is `HttpOnly`, `Secure`, `SameSite=Lax`.
- [ ] MongoDB listens on `127.0.0.1` only (not `0.0.0.0`) and the firewall exposes just ports 80/443.
- [ ] `.env`, `uploads/` and `output/` are not inside anything the proxy serves.
- [ ] Back up MongoDB and the `output/` folder (generated memes and their version history live there).
- [ ] `npm run auth:reset-password` works from the server shell (you will need it one day).

## What is not covered

- **The AI vision tool.** Viral adaptation runs the `agy` CLI from the owner's PC (a signed-in Gemini CLI under
  the user profile). A server needs that tool installed and signed in too, and its models reachable from the
  server's network. Without it, hosting still serves the gallery, Settings, manual Create and Instagram
  publishing, but **Viral Adaptation will not work**. Decide this before renting a server.
- **Verified here:** the sign-in logic, cookie flags, lockout, Host/Origin rules and public/private route split
  were tested against a scratch server by simulating the public host name and a proxy's `X-Forwarded-For`. A real
  Caddy/nginx deployment with a real certificate was **not** tested; follow section 5 on your own deployment.
- Single owner, single server process. More people or several servers would need accounts with roles and a
  shared store for the sign-in limits (they live in memory).
- No two-factor sign-in; use a long password (a few random words) and keep sign-in limits on.
