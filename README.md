# surfshark-for-clash

A Cloudflare Worker that converts [Surfshark](https://surfshark.com) WireGuard server data into a [Clash](https://github.com/Dreamacro/clash) subscription config, always up to date with Surfshark's server list.

## How it works

When Clash fetches the subscription URL, the Worker:

1. Fetches live server data from the Surfshark clusters API
2. Filters and converts it into a valid Clash WireGuard proxy config
3. Returns the YAML with a `profile-update-interval: 6` header so Clash re-fetches automatically every 6 hours

Surfshark API responses are cached at the edge for 5 minutes to avoid hammering upstream.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is sufficient)
- This repository pushed to GitHub
- Your Surfshark WireGuard **private key** — find it in the Surfshark app under **Settings → VPN protocols → WireGuard → Manual setup** (`PrivateKey` field in the generated config)

## Deploy

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages → Create**
2. Choose **Connect to Git** and select this repository
3. Set the following build configuration:
   - **Framework preset:** None
   - **Build command:** *(leave empty)*
   - **Deploy command:** `npx wrangler deploy`
4. Click **Save and Deploy**

Your Worker will be live at:
```
https://surfshark-clash.<your-subdomain>.workers.dev
```

## Usage

Paste the subscription URL into Clash under **Profiles → Add Subscription**:

```
https://surfshark-clash.<your-subdomain>.workers.dev/?pk=<PRIVATE_KEY>
```

### Query parameters

| Parameter      | Required | Description                                | Default     |
|----------------|----------|--------------------------------------------|-------------|
| `pk`           | Yes      | Your WireGuard private key (base64)        | —           |
| `ip`           | No       | Your WireGuard client IP                   | `10.14.0.2` |
| `port`         | No       | WireGuard UDP port                         | `51820`     |
| `types`        | No       | Node types: `generic`, `static`, or `all` | `generic`   |
| `group_region` | No       | Include per-region proxy groups            | `true`      |
| `group_p2p`    | No       | Include a P2P-only proxy group             | `true`      |

### Examples

```
# All generic servers (default)
?pk=BASE64KEY

# Include static servers too
?pk=BASE64KEY&types=all

# No per-region groups
?pk=BASE64KEY&group_region=false

# Minimal — just Auto and Select, no extra groups
?pk=BASE64KEY&group_region=false&group_p2p=false
```

## Node types

| Type       | Count | Description                                                                 |
|------------|-------|-----------------------------------------------------------------------------|
| `generic`  | ~142  | Standard servers. Most are virtual (physical hardware may differ by country). |
| `static`   | ~36   | Dedicated, fixed IP address. Useful for IP whitelisting. Always physical.   |
| `obfuscated` | 7  | Traffic disguised as HTTPS. **Not supported** — no WireGuard public key.   |

## Generated proxy groups

The config includes three types of proxy groups:

- **🌍 Surfshark Auto** — `url-test` group, automatically picks the lowest-latency node (checked every 5 minutes)
- **🖐 Surfshark Select** — manual `select` group with all nodes listed
- **⚡ Surfshark P2P** — `select` group containing only P2P-tagged nodes (disable with `group_p2p=false`)
- **Per-region groups** — one `select` group per geographic region (disable with `group_region=false`)

## Security note

Your WireGuard private key is passed as a URL query parameter. Anyone with the full subscription URL can see it. Keep the URL private and treat it like a password.

## Files

```
worker.js  — Cloudflare Worker (ES module)
```
