// Service Worker - Mapa de Entregas v5
const CACHE_NAME = 'mapa-entregas-v6';
const TILE_CACHE_NAME = 'mapbox-tiles-v2';
const MAPBOX_API_CACHE = 'mapbox-api-v1';
const HTML_CACHE_NAME = 'mapa-html-v4';

// Ícones inline para notificações push (evita arquivos externos)
const NOTIFICATION_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIiIGhlaWdodD0iMTkyIiB2aWV3Qm94PSIwIDAgMTkyIDE5MiI+PGNpcmNsZSBjeD0iOTYiIGN5PSI5NiIgcj0iOTYiIGZpbGw9IiMzYjgyZjYiLz48cGF0aCBkPSJNOTYgMzJjLTI2LjUgMC00OCAyMS41LTQ4IDQ4djE2YzAgMTcuNy0xNC4zIDMyLTMyIDMydjE2aDY0YzAgMTcuNyAxNC4zIDMyIDMyIDMyczMyLTE0LjMgMzItMzJoNjR2LTE2Yy0xNy43IDAtMzItMTQuMy0zMi0zMlY4MGMwLTI2LjUtMjEuNS00OC00OC00OHoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';
const NOTIFICATION_BADGE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIgdmlld0JveD0iMCAwIDcyIDcyIj48Y2lyY2xlIGN4PSIzNiIgY3k9IjM2IiByPSIzNiIgZmlsbD0iIzNiODJmNiIvPjxwYXRoIGQ9Ik0zNiAxMmMtOS45IDAtMTggOC4xLTE4IDE4djZjMCA2LjYtNS40IDEyLTEyIDEydjZoMjRjMCA2LjYgNS40IDEyIDEyIDEyczEyLTUuNCAxMi0xMmgyNHYtNmMtNi42IDAtMTItNS40LTEyLTEydi02YzAtOS45LTguMS0xOC0xOC0xOHoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

// Assets CDN para cache
const CDN_ASSETS = [
    './vendor/mapbox-gl/mapbox-gl.min.css',
    './vendor/mapbox-gl/mapbox-gl.min.js',
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

// ================================
// Helpers - Tiles / Pré-cache offline de área
// ================================
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Conversão lon/lat -> tile x/y (Web Mercator)
function lon2tileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function lat2tileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  const n = Math.tan(Math.PI / 4 + rad / 2);
  return Math.floor((1 - Math.log(n) / Math.PI) / 2 * Math.pow(2, z));
}

function tilesForBBox(bbox, z) {
  const [west, south, east, north] = bbox;
  const xMin = lon2tileX(west, z);
  const xMax = lon2tileX(east, z);
  const yMin = lat2tileY(north, z);
  const yMax = lat2tileY(south, z);
  const tiles = [];
  for (let x = clamp(xMin, 0, Math.pow(2, z) - 1); x <= clamp(xMax, 0, Math.pow(2, z) - 1); x++) {
    for (let y = clamp(yMin, 0, Math.pow(2, z) - 1); y <= clamp(yMax, 0, Math.pow(2, z) - 1); y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

function styleToApiUrl(styleUrl, accessToken) {
  // mapbox://styles/{user}/{style}
  if (!styleUrl || typeof styleUrl !== 'string') return null;
  if (styleUrl.startsWith('mapbox://styles/')) {
    const p = styleUrl.replace('mapbox://styles/', '').split('/');
    const user = p[0];
    const style = p[1];
    if (!user || !style) return null;
    const u = new URL(`https://api.mapbox.com/styles/v1/${user}/${style}`);
    if (accessToken) u.searchParams.set('access_token', accessToken);
    return u.toString();
  }
  // já é URL
  try {
    const u = new URL(styleUrl);
    if (accessToken && !u.searchParams.get('access_token') && u.hostname.includes('mapbox.com')) {
      u.searchParams.set('access_token', accessToken);
    }
    return u.toString();
  } catch {
    return null;
  }
}

async function broadcastToClients(message) {
  const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  for (const c of allClients) c.postMessage(message);
}

async function fetchAndCache(url, cacheName) {
  const cache = await caches.open(cacheName);
  const req = new Request(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
  const res = await fetch(req);
  if (res && res.ok) {
    await cache.put(req, res.clone());
    return true;
  }
  return false;
}

async function precacheMapboxArea({ areaName, bbox, minZoom, maxZoom, styleUrl, accessToken }) {
  const apiStyleUrl = styleToApiUrl(styleUrl, accessToken);
  if (!apiStyleUrl) throw new Error('styleUrl inválida para precache');

  // 1) Cacheia o JSON do style e descobre templates (tiles/sprites/glyphs)
  const styleRes = await fetch(apiStyleUrl, { cache: 'no-store' });
  if (!styleRes.ok) throw new Error(`Falha ao baixar style: ${styleRes.status}`);
  const styleJson = await styleRes.json();

  // Cache do style JSON
  const apiCache = await caches.open(MAPBOX_API_CACHE);
  await apiCache.put(new Request(apiStyleUrl), new Response(JSON.stringify(styleJson), {
    headers: { 'Content-Type': 'application/json' }
  }));

  const tileTemplates = [];
  for (const key of Object.keys(styleJson.sources || {})) {
    const src = styleJson.sources[key];
    if (src && Array.isArray(src.tiles)) {
      for (const t of src.tiles) tileTemplates.push(t);
    }
  }

  // Sprites (json + png)
  const spriteBase = styleJson.sprite; // ex: mapbox://sprites/mapbox/streets-v12
  const spriteUrls = [];
  if (spriteBase) {
    const base = spriteBase.startsWith('mapbox://sprites/')
      ? spriteBase.replace('mapbox://sprites/', 'https://api.mapbox.com/styles/v1/')
      : spriteBase;
    // Mapbox sprite API: {base}/sprite@2x.json|png e sprite.json|png
    for (const suffix of ['sprite.json', 'sprite.png', 'sprite@2x.json', 'sprite@2x.png']) {
      try {
        const u = new URL(`${base}/${suffix}`);
        if (accessToken) u.searchParams.set('access_token', accessToken);
        spriteUrls.push(u.toString());
      } catch {}
    }
  }

  // Glyphs: não pré-baixamos todos (seria enorme), mas garantimos cache-on-demand via fetch handler.

  // 2) Gera lista de URLs de tiles para o bbox/zooms
  const urls = [];
  const z0 = clamp(parseInt(minZoom, 10) || 0, 0, 22);
  const z1 = clamp(parseInt(maxZoom, 10) || z0, 0, 22);

  for (let z = z0; z <= z1; z++) {
    const tiles = tilesForBBox(bbox, z);
    for (const { z:tz, x, y } of tiles) {
      for (const tpl of tileTemplates) {
        const u = tpl.replace('{z}', String(tz)).replace('{x}', String(x)).replace('{y}', String(y));
        try {
          const urlObj = new URL(u);
          if (accessToken && !urlObj.searchParams.get('access_token') && urlObj.hostname.includes('mapbox.com')) {
            urlObj.searchParams.set('access_token', accessToken);
          }
          urls.push(urlObj.toString());
        } catch {
          // ignora templates inválidos
        }
      }
    }
  }

  // inclui sprites e o style (reforço)
  urls.push(apiStyleUrl, ...spriteUrls);

  // 3) Baixa com concorrência limitada
  const total = urls.length;
  let done = 0;
  let cached = 0;

  const concurrency = 10;
  const queue = urls.slice();

  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      try {
        const isTile = url.includes('/tiles/') || url.includes('/v4/') || url.includes('.pbf') || url.includes('raster') || url.includes('vector');
        const cacheName = isTile ? TILE_CACHE_NAME : MAPBOX_API_CACHE;
        const ok = await fetchAndCache(url, cacheName);
        if (ok) cached++;
      } catch {}
      done++;
      if (done % 25 === 0 || done === total) {
        const percent = total ? Math.round((done / total) * 100) : 100;
        await broadcastToClients({ type: 'PRECACHE_PROGRESS', areaName, done, total, percent });
      }
    }
  };

  await broadcastToClients({ type: 'PRECACHE_PROGRESS', areaName, done: 0, total, percent: 0 });

  await Promise.all(Array.from({ length: concurrency }, worker));

  await broadcastToClients({ type: 'PRECACHE_DONE', areaName, cached, total });
  return { cached, total };
}


// Instalação - cache de assets estáticos
self.addEventListener('install', event => {
    // Obtém o scope dentro do evento onde self.registration está disponível
    const scope = self.registration.scope;
    console.log('📦 Service Worker: Instalando...', scope);

    event.waitUntil(
        (async () => {
            // Cache para assets CDN
            const cache = await caches.open(CACHE_NAME);
            console.log('📦 Cacheando assets CDN...');

            // Cacheia CDN assets (pode falhar individualmente sem quebrar tudo)
            for (const url of CDN_ASSETS) {
                try {
                    const response = await fetch(url, { mode: 'cors' });
                    if (response.ok) {
                        await cache.put(url, response);
                        console.log('📦 Cacheado:', url.split('/').pop());
                    }
                } catch (err) {
                    console.warn('⚠️ Falha ao cachear:', url, err.message);
                }
            }

            // Cache HTML principal - CRÍTICO para offline
            const htmlCache = await caches.open(HTML_CACHE_NAME);
            console.log('📦 Cacheando página HTML...');

            try {
                // Cacheia a página principal (scope = URL base do app)
                const mainResponse = await fetch(scope, { cache: 'reload' });
                if (mainResponse.ok) {
                    // Salva com múltiplas chaves para garantir que encontre offline
                    await htmlCache.put(new Request(scope), mainResponse.clone());
                    await htmlCache.put(new Request(scope + 'index.html'), mainResponse.clone());
                    await htmlCache.put('offline-fallback', mainResponse.clone());
                    console.log('✅ HTML cacheado com sucesso:', scope);
                } else {
                    console.warn('⚠️ Resposta não-ok para HTML:', mainResponse.status);
                }
            } catch (err) {
                console.error('❌ Erro ao cachear HTML:', err);
            }

            console.log('✅ Service Worker instalado');
            await self.skipWaiting();
        })()
    );
});

// Ativação - limpa caches antigos e assume controle
self.addEventListener('activate', event => {
    console.log('🔄 Service Worker: Ativando...');
    const validCaches = [CACHE_NAME, TILE_CACHE_NAME, HTML_CACHE_NAME];

    event.waitUntil(
        (async () => {
            // Limpa caches antigos
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(cacheName => {
                    if (!validCaches.includes(cacheName)) {
                        console.log('🗑️ Removendo cache antigo:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );

            // Assume controle de todas as páginas imediatamente
            await self.clients.claim();
            console.log('✅ Service Worker ativado e controlando páginas');
        })()
    );
});

// Limite de tiles no cache
const MAX_TILE_CACHE_SIZE = 500;

async function limitCacheSize(cacheName, maxSize) {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxSize) {
        const toDelete = keys.slice(0, keys.length - maxSize);
        await Promise.all(toDelete.map(key => cache.delete(key)));
    }
}

// Busca HTML do cache com múltiplas tentativas
async function getOfflineHTML(request) {
    console.log('📴 Buscando HTML offline para:', request.url);

    // 1. Tenta match exato
    let cached = await caches.match(request);
    if (cached) {
        console.log('📴 [1] Match exato encontrado');
        return cached;
    }

    // 2. Tenta match por URL string
    cached = await caches.match(request.url);
    if (cached) {
        console.log('📴 [2] Match por URL encontrado');
        return cached;
    }

    // 3. Tenta o fallback específico
    const htmlCache = await caches.open(HTML_CACHE_NAME);
    cached = await htmlCache.match('offline-fallback');
    if (cached) {
        console.log('📴 [3] Fallback offline encontrado');
        return cached;
    }

    // 4. Busca qualquer entrada no HTML cache
    const htmlKeys = await htmlCache.keys();
    console.log('📴 [4] Chaves no HTML cache:', htmlKeys.length);
    for (const key of htmlKeys) {
        cached = await htmlCache.match(key);
        if (cached) {
            console.log('📴 [4] Usando chave:', key.url || key);
            return cached;
        }
    }

    // 5. Busca em todos os caches por HTML
    const allCacheNames = await caches.keys();
    for (const cacheName of allCacheNames) {
        const cache = await caches.open(cacheName);
        const keys = await cache.keys();
        for (const key of keys) {
            if (key.url && (key.url.endsWith('/') || key.url.endsWith('.html') || key.url.endsWith('index.html'))) {
                cached = await cache.match(key);
                if (cached) {
                    console.log('📴 [5] HTML encontrado em cache:', cacheName, key.url);
                    return cached;
                }
            }
        }
    }

    console.log('📴 Nenhum HTML encontrado no cache');
    return null;
}

// Estratégia de cache para diferentes tipos de requisição
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Ignora requisições não-GET
    if (event.request.method !== 'GET') return;

    // Ignora extensões do Chrome e requisições internas
    if (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:') return;

    // Navegação (página HTML) - network-first com fallback robusto
    if (event.request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    // Tenta buscar da rede
                    const response = await fetch(event.request);

                    if (response.ok) {
                        // Atualiza o cache em background
                        const htmlCache = await caches.open(HTML_CACHE_NAME);
                        await htmlCache.put(event.request, response.clone());
                        await htmlCache.put('offline-fallback', response.clone());
                        console.log('📥 HTML atualizado no cache');
                    }

                    return response;
                } catch (error) {
                    console.log('📴 Offline detectado, buscando do cache...');

                    // Offline - busca do cache
                    const cached = await getOfflineHTML(event.request);

                    if (cached) {
                        return cached;
                    }

                    // Página offline estática como último recurso
                    return new Response(`
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="UTF-8">
                            <meta name="viewport" content="width=device-width, initial-scale=1.0">
                            <title>Offline - Mapa de Entregas</title>
                            <style>
                                body {
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                                    display: flex;
                                    flex-direction: column;
                                    align-items: center;
                                    justify-content: center;
                                    min-height: 100vh;
                                    margin: 0;
                                    background: linear-gradient(135deg, #1e3a5f 0%, #0f172a 100%);
                                    color: white;
                                    text-align: center;
                                    padding: 20px;
                                }
                                h1 { font-size: 3rem; margin-bottom: 0.5rem; }
                                p { font-size: 1.2rem; opacity: 0.8; max-width: 400px; }
                                .info { font-size: 0.9rem; opacity: 0.6; margin-top: 1rem; }
                                button {
                                    margin-top: 2rem;
                                    padding: 12px 24px;
                                    font-size: 1rem;
                                    background: #3b82f6;
                                    color: white;
                                    border: none;
                                    border-radius: 8px;
                                    cursor: pointer;
                                }
                                button:hover { background: #2563eb; }
                            </style>
                        </head>
                        <body>
                            <h1>📴</h1>
                            <h2>Você está offline</h2>
                            <p>O aplicativo precisa ser carregado online pelo menos uma vez para funcionar offline.</p>
                            <p class="info">Conecte-se à internet e recarregue a página.</p>
                            <button onclick="location.reload()">Tentar novamente</button>
                        </body>
                        </html>
                    `, {
                        headers: { 'Content-Type': 'text/html; charset=utf-8' }
                    });
                }
            })()
        );
        return;
    }

        // Mapbox (tiles, styles, sprites, glyphs) - stale-while-revalidate com fallback offline
    if (url.hostname.includes('api.mapbox.com') || url.hostname.includes('tiles.mapbox.com')) {
        const isTile =
            url.pathname.includes('/v4/') ||
            url.pathname.includes('/tiles/') ||
            url.pathname.endsWith('.pbf') ||
            url.pathname.endsWith('.mvt') ||
            url.pathname.endsWith('.png') && url.pathname.includes('tiles') ||
            url.pathname.endsWith('.jpg') && url.pathname.includes('tiles');

        const cacheName = isTile ? TILE_CACHE_NAME : MAPBOX_API_CACHE;

        event.respondWith(
            caches.open(cacheName).then(async cache => {
                const cached = await cache.match(event.request);

                const fetchPromise = fetch(event.request).then(response => {
                    if (response && response.ok) {
                        cache.put(event.request, response.clone());
                        if (isTile) limitCacheSize(TILE_CACHE_NAME, MAX_TILE_CACHE_SIZE);
                    }
                    return response;
                }).catch(() => null);

                // Se temos cache, retorna imediatamente e tenta atualizar em background
                if (cached) {
                    fetchPromise; // best-effort
                    return cached;
                }

                // Sem cache: tenta rede; se falhar, responde erro (evita "cinza" quando já existe cache)
                const net = await fetchPromise;
                if (net) return net;

                return new Response(JSON.stringify({ error: 'offline' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' }
                });
            })
        );
        return;
    }

return;
    }

    // CDN assets (fonts, scripts) - cache-first
    if (url.hostname.includes('cdn.jsdelivr.net') ||
        url.hostname.includes('cdnjs.cloudflare.com') ||
        url.hostname.includes('fonts.googleapis.com') ||
        url.hostname.includes('fonts.gstatic.com') ||
        url.hostname.includes('unpkg.com')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;

                return fetch(event.request).then(response => {
                    if (response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => {
                    console.log('📴 CDN não disponível offline:', url.pathname);
                    return new Response('', { status: 503 });
                });
            })
        );
        return;
    }

    // Supabase - network-only (dados vêm do IndexedDB quando offline)
    if (url.hostname.includes('supabase.co')) {
        event.respondWith(
            fetch(event.request).catch(() => {
                return new Response(JSON.stringify({ error: 'offline' }), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' }
                });
            })
        );
        return;
    }

    // Outros recursos - network-first com cache fallback
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.ok && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(event.request);
                return cached || new Response('', { status: 503 });
            })
    );
});

// Background sync para dados offline
self.addEventListener('sync', event => {
    if (event.tag === 'sync-pending-data') {
        event.waitUntil(
            self.clients.matchAll().then(clients => {
                clients.forEach(client => {
                    client.postMessage({ type: 'SYNC_REQUEST' });
                });
            })
        );
    }
});

// Mensagens do app principal
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }

    if (event.data === 'getVersion') {
        event.source.postMessage({ type: 'VERSION', version: CACHE_NAME });
    }

    // Comando para forçar cache do HTML atual
    if (event.data === 'cacheCurrentPage') {
        const scope = self.registration.scope;
        fetch(scope)
            .then(response => {
                if (response.ok) {
                    return caches.open(HTML_CACHE_NAME).then(cache => {
                        cache.put('offline-fallback', response.clone());
                        cache.put(new Request(scope), response);
                        console.log('📦 Página cacheada via mensagem');
                    });
                }
            })
            .catch(err => console.warn('⚠️ Erro ao cachear página:', err));
    }
});

// Push notifications
self.addEventListener('push', event => {
    if (event.data) {
        const data = event.data.json();
        event.waitUntil(
            self.registration.showNotification(data.title || 'Mapa de Entregas', {
                body: data.body || '',
                icon: data.icon || NOTIFICATION_ICON,
                badge: NOTIFICATION_BADGE,
                data: data.data || {}
            })
        );
    }
});

// Click em notificação
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(self.registration.scope)
    );

    // Pré-cache de área do Mapbox (tiles + style/sprites) para uso offline
    if (event.data && event.data.type === 'PRECACHE_MAPBOX_AREA') {
        const port = event.ports && event.ports[0];
        (async () => {
            try {
                const payload = event.data || {};
                await precacheMapboxArea({
                    areaName: payload.areaName || payload.areaName === '' ? payload.areaName : 'área',
                    bbox: payload.bbox,
                    minZoom: payload.minZoom,
                    maxZoom: payload.maxZoom,
                    styleUrl: payload.styleUrl,
                    accessToken: payload.accessToken
                });
                if (port) port.postMessage(true);
            } catch (err) {
                const error = (err && err.message) ? err.message : String(err);
                await broadcastToClients({ type: 'PRECACHE_ERROR', error });
                if (port) port.postMessage({ ok: false, error });
            }
        })();
    }
});

console.log('🚀 Service Worker v6 carregado');
