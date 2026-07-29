/* Service worker: houdt de app beschikbaar zonder netwerk.
   Alleen bestanden van deze site worden gecachet; API-verkeer nooit. */
const CACHE = "bonnetjes-v1";
const BESTANDEN = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./xlsx.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(BESTANDEN)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then(namen => Promise.all(namen.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;

  // Netwerk eerst, zodat een nieuwe versie meteen doorkomt; cache als terugval.
  e.respondWith(
    fetch(e.request)
      .then(antwoord => {
        const kopie = antwoord.clone();
        caches.open(CACHE).then(c => c.put(e.request, kopie));
        return antwoord;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});
