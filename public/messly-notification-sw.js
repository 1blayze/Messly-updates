self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  const data = event.notification?.data || {};
  const conversationId = String(data.conversationId || "").trim();
  event.notification?.close();

  const targetUrl = conversationId
    ? `/#/app?conversation=${encodeURIComponent(conversationId)}`
    : "/#/app";

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      if (clients.length > 0) {
        const targetClient = clients[0];
        targetClient.postMessage({
          type: "messly:notification-click",
          conversationId,
        });
        await targetClient.focus();
        return;
      }

      const createdClient = await self.clients.openWindow(targetUrl);
      if (createdClient) {
        createdClient.postMessage({
          type: "messly:notification-click",
          conversationId,
        });
      }
    })(),
  );
});
