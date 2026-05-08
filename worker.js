/**
 * Surfshark → Clash Subscription Worker
 * Deploy to Cloudflare Workers
 *
 * Subscription URL:
 *   https://<your-worker>.workers.dev/?pk=<PRIVATE_KEY>&ip=<CLIENT_IP>
 *
 * Query parameters:
 *   pk           Your Surfshark WireGuard private key (base64) [required]
 *   ip           Your WireGuard client IP                     (default: 10.14.0.2)
 *   port         WireGuard UDP port                           (default: 51820)
 *   types        Comma-separated node types: generic, static, all (default: generic)
 *   group_region Include per-region proxy groups              (default: true)
 *   group_p2p    Include a P2P-only proxy group               (default: true)
 *
 * Clash will automatically re-fetch this URL on the interval set by
 * the profile-update-interval response header (default: every 6 hours).
 */

const API_BASE     = 'https://api.surfshark.com/v4/server/clusters'
const SURFSHARK_DNS = ['162.252.172.57', '162.252.172.58']
const CACHE_TTL    = 300  // seconds — how long upstream API responses are cached

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
  if (node.type === 'static')     extras += ' [Static]'
  if (tags.includes('p2p'))       extras += ' [P2P]'
  if (tags.includes('virtual'))   extras += ' [V]'
  return `${flag} ${node.country} - ${node.location}${extras}`
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

function buildConfig(proxies, nodes, { groupRegion, groupP2p }) {
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
    // ── Auto (url-test) ──
    '  - name: "🌍 Surfshark Auto"',
    '    type: url-test',
    '    url: http://www.gstatic.com/generate_204',
    '    interval: 300',
    '    tolerance: 50',
    '    proxies:',
    ...allNames.map(n => `      - "${n}"`),
    '',
    // ── Manual select ──
    '  - name: "🖐 Surfshark Select"',
    '    type: select',
    '    proxies:',
    '      - "🌍 Surfshark Auto"',
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

// ─── Request handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // Only handle GET
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }

    const url = new URL(request.url)

    // Show usage if no private key provided
    if (!url.searchParams.has('pk')) {
      return new Response(USAGE, {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }

    // ── Parse parameters ──────────────────────────────────────────────────
    const privateKey  = url.searchParams.get('pk')           ?? 'YOUR_PRIVATE_KEY'
    const clientIp    = url.searchParams.get('ip')           ?? '10.14.0.2'
    const port        = parseInt(url.searchParams.get('port') ?? '51820')
    const typesParam  = url.searchParams.get('types')        ?? 'generic'
    const groupRegion = flag(url.searchParams.get('group_region'), true)
    const groupP2p    = flag(url.searchParams.get('group_p2p'),    true)

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

      if (nodes.length === 0) {
        return new Response(
          '# No nodes matched the given filters.\n',
          { status: 200, headers: { 'Content-Type': 'text/yaml; charset=utf-8' } },
        )
      }

      // ── Build and return YAML ─────────────────────────────────────────
      const proxies = nodes.map(n => buildProxy(n, privateKey, clientIp, port))
      const yaml    = buildConfig(proxies, nodes, { groupRegion, groupP2p })

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

// ─── Usage page ──────────────────────────────────────────────────────────────

const USAGE = `Surfshark → Clash Subscription Worker

Required parameters:
  pk            WireGuard private key (base64)

Optional parameters:
  ip            WireGuard client IP          (default: 10.14.0.2)
  port          WireGuard UDP port           (default: 51820)
  types         generic | static | all       (default: generic)
  group_region  Include per-region groups    (default: true)
  group_p2p     Include P2P group            (default: true)

Example:
  https://<your-worker>.workers.dev/?pk=BASE64KEY
  https://<your-worker>.workers.dev/?pk=BASE64KEY&types=all&group_region=false
`
