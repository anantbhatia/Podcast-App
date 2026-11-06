// Service worker for new-episode notifications. It only shows the pushes the site's
// worker sends (src/push.mjs) and opens the episode when one is tapped.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || "New episode of Two Hallucinating PMs";
  e.waitUntil(self.registration.showNotification(title, {
    body: data.body || "A new episode is up.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "episode",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.split("#")[0] === url.split("#")[0] && "focus" in c);
    return open ? open.navigate(url).then((c) => c && c.focus()) : self.clients.openWindow(url);
  }));
});
