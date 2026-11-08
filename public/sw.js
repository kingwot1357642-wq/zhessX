// Minimal service worker: only here so browsers treat the game as an installable app.
// It does not cache anything (the game needs the live server anyway).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
