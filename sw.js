// Service Worker - Mapa de Entregas v5
const CACHE_NAME = 'mapa-entregas-v5';
const TILE_CACHE_NAME = 'mapbox-tiles-v1';
const HTML_CACHE_NAME = 'mapa-html-v3';

// Ícones inline para notificações push (evita arquivos externos)
const NOTIFICATION_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIiIGhlaWdodD0iMTkyIiB2aWV3Qm94PSIwIDAgMTkyIDE5MiI+PGNpcmNsZSBjeD0iOTYiIGN5PSI5NiIgcj0iOTYiIGZpbGw9IiMzYjgyZjYiLz48cGF0aCBkPSJNOTYgMzJjLTI2LjUgMC00OCAyMS41LTQ4IDQ4djE2YzAgMTcuNy0xNC4zIDMyLTMyIDMydjE2aDY0YzAgMTcuNyAxNC4zIDMyIDMyIDMyczMyLTE0LjMgMzItMzJoNjR2LTE2Yy0xNy43IDAtMzItMTQuMy0zMi0zMlY4MGMwLTI2LjUtMjEuNS00OC00OC00OHoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';
const NOTIFICATION_BADGE = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3MiIgaGVpZ2h0PSI3MiIgdmlld0JveD0iMCAwIDcyIDcyIj48Y2lyY2xlIGN4PSIzNiIgY3k9IjM2IiByPSIzNiIgZmlsbD0iIzNiODJmNiIvPjxwYXRoIGQ9Ik0zNiAxMmMtOS45IDAtMTggOC4xLTE4IDE4djZjMCA2LjYtNS40IDEyLTEyIDEydjZoMjRjMCA2LjYgNS40IDEyIDEyIDEyczEyLTUuNCAxMi0xMmgyNHYtNmMtNi42IDAtMTItNS40LTEyLTEydi02YzAtOS45LTguMS0xOC0xOC0xOHoiIGZpbGw9IiNmZmYiLz48L3N2Zz4=';

// Assets CDN para cache
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/mapbox-gl@3.4.0/dist/mapbox-gl.min.css',
    'https://cdn.jsdelivr.net/npm/mapbox-gl@3.4.0/dist/mapbox-gl.min.js',
    'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap',
    'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
    'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js',
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js'
];

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

    // Tiles do Mapbox - stale-while-revalidate
    if (url.hostname.includes('tiles.mapbox.com') ||
        url.hostname.includes('api.mapbox.com') ||
        url.pathname.includes('/v4/') ||
        url.pathname.includes('/styles/')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(async cache => {
                const cached = await cache.match(event.request);
                const fetchPromise = fetch(event.request).then(response => {
                    if (response.ok) {
                        cache.put(event.request, response.clone());
                        limitCacheSize(TILE_CACHE_NAME, MAX_TILE_CACHE_SIZE);
                    }
                    return response;
                }).catch(() => cached);

                return cached || fetchPromise;
            })
        );
        return;
    }

    // Recursos do Mapbox (estilos, fontes, sprites, glyphs) - cache-first
    if (url.hostname.includes('mapbox.com')) {
        event.respondWith(
            caches.open(TILE_CACHE_NAME).then(async cache => {
                const cached = await cache.match(event.request);
                if (cached) return cached;

                try {
                    const response = await fetch(event.request);
                    if (response.ok) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                } catch (error) {
                    console.log('📴 Mapbox recurso não disponível offline:', url.pathname);
                    return new Response('', { status: 503 });
                }
            })
        );
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
});

console.log('🚀 Service Worker v5 carregado');
