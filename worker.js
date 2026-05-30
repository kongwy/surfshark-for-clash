/**
 * Surfshark → Clash Subscription Worker
 * Deploy to Cloudflare Workers
 *
 * Open the worker URL in a browser to use the generator page, which produces
 * a properly encoded subscription URL to paste into your Clash client.
 *
 * Direct URL (parameters must be percent-encoded — use the generator page):
 *   https://<your-worker>.workers.dev/?pk=<PERCENT_ENCODED_PRIVATE_KEY>
 *
 * Query parameters:
 *   pk           Your Surfshark WireGuard private key (base64, percent-encoded) [required]
 *   ip           Your WireGuard client IP                     (default: 10.14.0.2)
 *   port         WireGuard UDP port                           (default: 51820)
 *   types        Comma-separated node types: generic, static, all (default: generic)
 *   countries    Comma-separated whitelist of country codes and/or region codes
 *                (e.g. us,jp,eu). A node passes if its countryCode or regionCode
 *                matches any token (case-insensitive). Empty = no filter.
 *   group_auto   Include the global url-test "Auto" group     (default: true)
 *   group_region Include per-region proxy groups              (default: true)
 *   group_p2p    Include a P2P-only proxy group               (default: true)
 *
 * Clash will automatically re-fetch this URL on the interval set by
 * the profile-update-interval response header (default: every 6 hours).
 */

const API_BASE      = 'https://api.surfshark.com/v4/server/clusters'
const SURFSHARK_DNS = ['162.252.172.57', '162.252.172.58']
const CACHE_TTL     = 300  // seconds — how long upstream API responses are cached

// ─── Helpers ────────────────────────────────────────────────────────────────

// Parse a boolean URL param: absent or any value other than "false"/"0" → defaultValue
function flag(value, defaultValue) {
  if (value === null) return defaultValue
  return value !== 'false' && value !== '0'
}

function flagEmoji(cc) {
  return [...cc.toUpperCase()]
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('')
}

function nodeName(node) {
  const flag  = flagEmoji(node.countryCode)
  const tags  = node.tags ?? []
  let extras  = ''
  let suffix  = ''
  if (node.type === 'static') {
    // Static servers share country/city, so disambiguate with the numeric
    // identifier from the connection hostname (e.g. de-fra-st003.prod… → 003)
    const match = node.connectionName?.match(/-st(\d+)\./)
    if (match) suffix = ` ${match[1]}`
    extras += ' [Static]'
  }
  if (tags.includes('p2p'))       extras += ' [P2P]'
  if (tags.includes('virtual'))   extras += ' [V]'
  return `${flag} ${node.country} - ${node.location}${suffix}${extras}`
}

// Minimal YAML serialiser — only handles the types we actually use
function yamlVal(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number')  return String(v)
  if (Array.isArray(v))       return `[${v.map(i => typeof i === 'string' ? `"${i}"` : i).join(', ')}]`
  const s = String(v)
  // Quote strings that contain YAML special characters or look like bare scalars
  if (/[:#{}[\],&*?|<>=!%@`]/.test(s) || /^(true|false|null|yes|no|\d)/.test(s)) return `"${s}"`
  return s
}

function proxyToYaml(proxy) {
  const lines = [`  - name: ${yamlVal(proxy.name)}`]
  for (const [k, v] of Object.entries(proxy)) {
    if (k !== 'name') lines.push(`    ${k}: ${yamlVal(v)}`)
  }
  return lines.join('\n')
}

// ─── Proxy builder ───────────────────────────────────────────────────────────

function buildProxy(node, privateKey, clientIp, port) {
  return {
    name:          nodeName(node),
    type:          'wireguard',
    server:        node.connectionName,
    port,
    ip:            clientIp,
    'public-key':  node.pubKey,
    'private-key': privateKey,
    dns:           SURFSHARK_DNS,
    'allowed-ips': ['0.0.0.0/0', '::/0'],
    mtu:           1420,
    udp:           true,
  }
}

// ─── Config builder ──────────────────────────────────────────────────────────

function buildConfig(proxies, nodes, { groupAuto, groupRegion, groupP2p }) {
  const allNames = proxies.map(p => p.name)

  // Per-region index
  const byRegion = {}
  nodes.forEach((node, i) => {
    ;(byRegion[node.region] ??= []).push(proxies[i].name)
  })

  // P2P index
  const p2pNames = nodes.flatMap((node, i) =>
    (node.tags ?? []).includes('p2p') ? [proxies[i].name] : []
  )

  const L = []  // output lines

  L.push(
    '# Surfshark WireGuard — Clash subscription',
    `# Generated at ${new Date().toUTCString()}`,
    '#',
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    'ipv6: false',
    'dns:',
    '  enable: true',
    '  ipv6: false',
    '  default-nameserver: [1.1.1.1, 8.8.8.8]',
    '  nameserver: [1.1.1.1, 8.8.8.8]',
    '',
    'proxies:',
    ...proxies.map(proxyToYaml),
    '',
    'proxy-groups:',
  )

  // ── Auto (url-test) ──
  // Skipping this group dramatically lowers memory use on memory-constrained
  // clients (e.g. iOS Network Extensions), since url-test maintains per-proxy
  // latency state for every member.
  if (groupAuto) {
    L.push(
      '  - name: "🌍 Surfshark Auto"',
      '    type: url-test',
      '    url: http://www.gstatic.com/generate_204',
      '    interval: 300',
      '    tolerance: 50',
      '    proxies:',
      ...allNames.map(n => `      - "${n}"`),
      '',
    )
  }

  // ── Manual select ──
  L.push(
    '  - name: "🖐 Surfshark Select"',
    '    type: select',
    '    proxies:',
    ...(groupAuto ? ['      - "🌍 Surfshark Auto"'] : []),
    ...allNames.map(n => `      - "${n}"`),
    '',
  )

  // ── P2P group ──
  if (groupP2p && p2pNames.length > 0) {
    L.push('  - name: "⚡ Surfshark P2P"', '    type: select', '    proxies:')
    p2pNames.forEach(n => L.push(`      - "${n}"`))
    L.push('')
  }

  // ── Per-region groups ──
  if (groupRegion) {
    for (const [region, names] of Object.entries(byRegion).sort()) {
      L.push(`  - name: "${region.replace(/"/g, "'")}"`, '    type: select', '    proxies:')
      names.forEach(n => L.push(`      - "${n}"`))
      L.push('')
    }
  }

  L.push('rules:', '  - GEOIP,CN,DIRECT', '  - MATCH,🖐 Surfshark Select')

  return L.join('\n') + '\n'
}

// ─── Upstream fetch with CF cache ────────────────────────────────────────────

async function fetchNodes(type, ctx) {
  const apiUrl    = type === 'generic' ? API_BASE : `${API_BASE}/${type}`
  const cache     = caches.default
  const cacheReq  = new Request(apiUrl)

  // Serve from cache if available
  const hit = await cache.match(cacheReq)
  if (hit) return hit.json()

  const resp = await fetch(apiUrl, {
    headers: { 'User-Agent': 'clash-config-builder/1.0' },
  })
  if (!resp.ok) throw new Error(`Surfshark API ${apiUrl} → HTTP ${resp.status}`)
  const data = await resp.json()

  // Store in cache asynchronously (don't block the response)
  ctx.waitUntil(
    cache.put(
      cacheReq,
      new Response(JSON.stringify(data), {
        headers: {
          'Content-Type':  'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      }),
    ),
  )

  return data
}

// ─── Generator page ──────────────────────────────────────────────────────────

function buildPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Surfshark → Clash</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      background: #f5f5f5;
      color: #1a1a1a;
      display: flex;
      justify-content: center;
      padding: 3rem 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0,0,0,.08);
      padding: 2rem;
      width: 100%;
      max-width: 520px;
    }
    h1 { font-size: 1.3rem; margin-bottom: 1.5rem; }
    .field { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
    label { font-size: .85rem; font-weight: 600; color: #555; }
    input[type=text], input[type=number], select {
      border: 1px solid #d0d0d0;
      border-radius: 6px;
      padding: .5rem .7rem;
      font-size: .95rem;
      width: 100%;
      outline: none;
      transition: border-color .15s;
    }
    input:focus, select:focus { border-color: #0070f3; }
    .checkrow { display: flex; align-items: center; gap: .5rem; }
    .checkrow input { width: auto; }
    button {
      width: 100%;
      padding: .65rem;
      background: #0070f3;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 1rem;
      cursor: pointer;
      margin-top: .5rem;
      transition: background .15s;
    }
    button:hover { background: #005ed1; }
    .result { margin-top: 1.5rem; display: none; }
    .result label { margin-bottom: .35rem; display: block; font-size: .85rem; font-weight: 600; color: #555; }
    .url-row { display: flex; gap: .5rem; }
    .url-row input {
      flex: 1;
      font-family: monospace;
      font-size: .8rem;
      background: #f9f9f9;
      color: #333;
    }
    .url-row button { width: auto; padding: .5rem 1rem; margin-top: 0; font-size: .85rem; }
    .copied { background: #16a34a !important; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Surfshark → Clash Subscription</h1>

    <div class="field">
      <label for="pk">WireGuard Private Key *</label>
      <input id="pk" type="text" placeholder="Paste your base64 private key from Surfshark" required>
    </div>

    <div class="field">
      <label for="ip">Client IP</label>
      <input id="ip" type="text" placeholder="10.14.0.2 (default)">
    </div>

    <div class="field">
      <label for="port">UDP Port</label>
      <input id="port" type="number" placeholder="51820 (default)">
    </div>

    <div class="field">
      <label for="types">Server Types</label>
      <select id="types">
        <option value="generic">Generic</option>
        <option value="static">Static</option>
        <option value="all">All</option>
      </select>
    </div>

    <div class="field">
      <label for="countries">Countries (optional)</label>
      <input id="countries" type="text" placeholder="e.g. us,jp,eu — country/region codes, empty = all">
    </div>

    <div class="field">
      <div class="checkrow">
        <input id="group_auto" type="checkbox" checked>
        <label for="group_auto">Include url-test Auto group (disable on iOS to save memory)</label>
      </div>
    </div>

    <div class="field">
      <div class="checkrow">
        <input id="group_region" type="checkbox" checked>
        <label for="group_region">Include per-region proxy groups</label>
      </div>
    </div>

    <div class="field">
      <div class="checkrow">
        <input id="group_p2p" type="checkbox" checked>
        <label for="group_p2p">Include P2P proxy group</label>
      </div>
    </div>

    <button onclick="generate()">Generate Subscription URL</button>

    <div class="result" id="result">
      <label>Subscription URL — paste this into your Clash client</label>
      <div class="url-row">
        <input id="output" type="text" readonly>
        <button id="copyBtn" onclick="copy()">Copy</button>
      </div>
    </div>
  </div>

  <script>
    function generate() {
      const pk = document.getElementById('pk').value.trim()
      if (!pk) { document.getElementById('pk').focus(); return }

      const params = new URLSearchParams()
      params.set('pk', pk)

      const ip = document.getElementById('ip').value.trim()
      if (ip) params.set('ip', ip)

      const port = document.getElementById('port').value.trim()
      if (port) params.set('port', port)

      params.set('types', document.getElementById('types').value)

      const countries = document.getElementById('countries').value.trim()
      if (countries) params.set('countries', countries)

      if (!document.getElementById('group_auto').checked)   params.set('group_auto', 'false')
      if (!document.getElementById('group_region').checked) params.set('group_region', 'false')
      if (!document.getElementById('group_p2p').checked)    params.set('group_p2p', 'false')

      const base = window.location.origin + window.location.pathname
      document.getElementById('output').value = base + '?' + params.toString()
      document.getElementById('result').style.display = 'block'
    }

    function copy() {
      navigator.clipboard.writeText(document.getElementById('output').value)
      const btn = document.getElementById('copyBtn')
      btn.textContent = 'Copied!'
      btn.classList.add('copied')
      setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied') }, 2000)
    }
  </script>
</body>
</html>`
}

// ─── Request handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Only handle GET
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const url = new URL(request.url)

    // Show generator page if no private key provided
    if (!url.searchParams.has('pk')) {
      return new Response(buildPage(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      })
    }

    // ── Parse parameters ──────────────────────────────────────────────────
    // pk must be percent-encoded — use the generator page to produce the URL
    const privateKey  = url.searchParams.get('pk')            ?? ''
    const clientIp    = url.searchParams.get('ip')            ?? '10.14.0.2'
    const port        = parseInt(url.searchParams.get('port') ?? '51820')
    const typesParam  = url.searchParams.get('types')         ?? 'generic'
    const groupAuto   = flag(url.searchParams.get('group_auto'),   true)
    const groupRegion = flag(url.searchParams.get('group_region'), true)
    const groupP2p    = flag(url.searchParams.get('group_p2p'),    true)

    // Whitelist filter — comma-separated, mixes country codes and region codes.
    const countries = new Set(
      (url.searchParams.get('countries') ?? '')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    )

    if (!privateKey) {
      return new Response('# Error: pk parameter is empty.\n', {
        status: 400,
        headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
      })
    }

    // Resolve which API types to fetch
    const requestedTypes = typesParam === 'all'
      ? ['generic', 'static']
      : typesParam.split(',').map(t => t.trim()).filter(t => ['generic', 'static'].includes(t))

    try {
      // ── Fetch & deduplicate ───────────────────────────────────────────
      let nodes = []
      for (const type of requestedTypes) {
        nodes.push(...await fetchNodes(type, ctx))
      }
      const seen = new Set()
      nodes = nodes.filter(n => !seen.has(n.id) && seen.add(n.id))

      // WireGuard only — must have a public key
      nodes = nodes.filter(n => n.pubKey)

      // Apply whitelist filter — a node passes if its countryCode or
      // regionCode matches any token.
      if (countries.size > 0) {
        nodes = nodes.filter(n =>
          countries.has((n.countryCode ?? '').toLowerCase()) ||
          countries.has((n.regionCode  ?? '').toLowerCase())
        )
      }

      if (nodes.length === 0) {
        return new Response(
          '# No nodes matched the given filters.\n',
          { status: 200, headers: { 'Content-Type': 'text/yaml; charset=utf-8' } },
        )
      }

      // ── Build and return YAML ─────────────────────────────────────────
      const proxies = nodes.map(n => buildProxy(n, privateKey, clientIp, port))
      const yaml    = buildConfig(proxies, nodes, { groupAuto, groupRegion, groupP2p })

      return new Response(yaml, {
        headers: {
          'Content-Type':            'text/yaml; charset=utf-8',
          'Cache-Control':           'no-store',
          'Content-Disposition':     'attachment; filename="clash_surfshark.yaml"',
          // Clash reads this header to schedule automatic re-fetches (hours)
          'profile-update-interval': '6',
          // Clash displays this in the subscription info panel
          'subscription-userinfo':   `upload=0; download=0; total=0; expire=0`,
        },
      })

    } catch (err) {
      return new Response(`# Error: ${err.message}\n`, {
        status: 502,
        headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
      })
    }
  },
}
