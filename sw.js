/*
 * Service worker de Ludia: permite instalarla como app, que abra rápido y que funcione sin internet.
 * - Páginas: primero la red (para ver siempre la última versión); si no hay conexión, la copia guardada.
 * - Código, pictogramas y voz de la propia web: la copia guardada y se actualiza por detrás.
 *   Al instalarse (y con cada versión nueva) descarga en segundo plano TODA la web
 *   (lista en precache.json, la genera scripts/publicar-web.sh), para que los juegos
 *   funcionen aunque se caiga el wifi del centro.
 * - Tipos de letra de Google y las imágenes propias del centro (/api/pictogramas/imagen/…):
 *   se guardan la primera vez que se ven (no cambian nunca).
 * - El resto de la API (alumnos, progreso) NUNCA se guarda aquí: son datos personales.
 *   (La tablet activada recuerda la lista de alumnos y sus rutinas por su cuenta: ver copia-local.interceptor.ts.)
 */
// Cambiar el número borra lo guardado en las tablets (por ejemplo, al cambiar la voz: los audios nuevos se llaman igual)
const CACHE = 'ludia-v4';
const CACHE_EXTERNA = 'ludia-externa-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((c) => c !== CACHE && c !== CACHE_EXTERNA).map((c) => caches.delete(c))))
      .then(() => self.clients.claim())
      .then(() => { precargar(); })
  );
});

// La app avisa al abrirse por si hay versión nueva que precargar
self.addEventListener('message', (event) => {
  if (event.data === 'precargar') precargar();
});

let precargando = null;

/** Descarga lo que falte de la web (de 6 en 6, sin prisa) y borra los ficheros de versiones viejas. */
function precargar() {
  if (precargando) return precargando;
  precargando = (async () => {
    try {
      const res = await fetch('/precache.json', { cache: 'no-cache' });
      if (!res.ok) return; // en local no existe
      const { ficheros } = await res.json();
      const cache = await caches.open(CACHE);
      const guardados = await cache.keys();
      const tengo = new Set(guardados.map((r) => new URL(r.url).pathname));
      const faltan = ficheros.filter((f) => !tengo.has(f));
      for (let i = 0; i < faltan.length; i += 6) {
        await Promise.all(faltan.slice(i, i + 6).map(async (f) => {
          try {
            const r = await fetch(f);
            if (r.ok) await cache.put(f, r);
          } catch { /* sin conexión: se intentará otro día */ }
        }));
      }
      // Fuera lo que ya no está en la web (código de versiones anteriores)
      const validos = new Set([...ficheros, '/']);
      await Promise.all(guardados
        .filter((r) => { const u = new URL(r.url); return u.origin === self.location.origin && !validos.has(u.pathname) && !u.search; })
        .map((r) => cache.delete(r)));
    } catch { /* lo intentamos la próxima vez */ } finally {
      precargando = null;
    }
  })();
  return precargando;
}

const esFuente = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
const esImagenPropia = (url) => url.pathname.startsWith('/api/pictogramas/imagen/');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Tipos de letra e imágenes propias: no cambian, la copia guardada vale para siempre
  if (esFuente(url) || esImagenPropia(url)) {
    event.respondWith(
      caches.open(CACHE_EXTERNA).then(async (cache) => {
        const guardada = await cache.match(req);
        if (guardada) return guardada;
        const res = await fetch(req);
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // API: lo normal del navegador

  // Lista de audios de la voz: siempre la última (si no hay conexión, la guardada)
  if (url.pathname === '/voz/indice.json') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copia));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      // 'no-cache': pregunta siempre al servidor si hay versión nueva (sin esperar los 10 minutos de GitHub Pages)
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          const copia = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copia));
          return res;
        })
        .catch(async () => (await caches.match('/')) || caches.match('/index.html'))
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardada = await cache.match(req, { ignoreSearch: url.pathname.endsWith('.png') || url.pathname.endsWith('.mp3') });
      const red = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => guardada);
      return guardada || red;
    })
  );
});
