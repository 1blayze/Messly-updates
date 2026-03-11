import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";

const port = Number.parseInt(process.env.MESSLY_GATEWAY_PORT ?? "8788", 10);
const supabaseUrl = String(process.env.SUPABASE_URL ?? "").trim();
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY sao obrigatorias para o gateway example.");
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 25,
    },
  },
});

const server = http.createServer();
const wss = new WebSocketServer({
  server,
  path: "/gateway",
});

let sequence = 0;
const sockets = new Set();
const sessionBySocket = new Map();
const socketsByTopic = new Map();
const socketsByUserId = new Map();

function nextSequence() {
  sequence += 1;
  return sequence;
}

function topicKey(type, id) {
  return `${type}:${id}`;
}

function parseFrame(raw) {
  try {
    return JSON.parse(String(raw ?? ""));
  } catch {
    return null;
  }
}

function sendFrame(socket, op, eventType, payload) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  socket.send(
    JSON.stringify({
      op,
      s: op === "DISPATCH" ? nextSequence() : null,
      t: eventType,
      d: payload,
    }),
  );
}

function addSocketToTopic(socket, subscription) {
  const key = topicKey(subscription.type, subscription.id);
  const topicSockets = socketsByTopic.get(key) ?? new Set();
  topicSockets.add(socket);
  socketsByTopic.set(key, topicSockets);
}

function removeSocketFromTopics(socket) {
  for (const topicSockets of socketsByTopic.values()) {
    topicSockets.delete(socket);
  }
}

function setSocketSubscriptions(socket, subscriptions) {
  const session = sessionBySocket.get(socket);
  if (!session) {
    return;
  }

  removeSocketFromTopics(socket);
  session.subscriptions = subscriptions;
  subscriptions.forEach((subscription) => addSocketToTopic(socket, subscription));
}

function fanoutToTopic(subscription, eventType, payload) {
  const subscribers = socketsByTopic.get(topicKey(subscription.type, subscription.id));
  if (!subscribers) {
    return;
  }

  subscribers.forEach((socket) => {
    sendFrame(socket, "DISPATCH", eventType, payload);
  });
}

function fanoutToUser(userId, eventType, payload) {
  fanoutToTopic({ type: "user", id: userId }, eventType, payload);
  fanoutToTopic({ type: "notifications", id: userId }, eventType, payload);
}

async function fanoutToFriends(userId, eventType, payload) {
  const { data, error } = await supabase
    .from("friend_requests")
    .select("requester_id,addressee_id")
    .eq("status", "accepted")
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);

  if (error) {
    console.error("[gateway:friends]", error);
    return;
  }

  const friendIds = (data ?? [])
    .map((row) => {
      return row.requester_id === userId ? row.addressee_id : row.requester_id;
    })
    .filter(Boolean);

  friendIds.forEach((friendId) => {
    fanoutToTopic({ type: "friends", id: friendId }, eventType, payload);
  });
}

async function validateToken(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    return null;
  }
  return data.user;
}

async function attachSession(socket, token, subscriptions, existingSessionId = null) {
  const user = await validateToken(token);
  if (!user) {
    sendFrame(socket, "INVALID_SESSION", null, { reason: "UNAUTHENTICATED" });
    socket.close(4001, "UNAUTHENTICATED");
    return;
  }

  const userSockets = socketsByUserId.get(user.id) ?? new Set();
  userSockets.add(socket);
  socketsByUserId.set(user.id, userSockets);

  const sessionId = existingSessionId || randomUUID();
  sessionBySocket.set(socket, {
    sessionId,
    userId: user.id,
    subscriptions,
  });

  setSocketSubscriptions(socket, subscriptions);
  sendFrame(socket, "DISPATCH", existingSessionId ? "RESUMED" : "READY", {
    sessionId,
    userId: user.id,
    subscriptions,
  });
}

async function handleClientPublish(socket, frame) {
  const session = sessionBySocket.get(socket);
  if (!session) {
    sendFrame(socket, "INVALID_SESSION", null, { reason: "MISSING_SESSION" });
    return;
  }

  if (frame.t === "PRESENCE_UPDATE") {
    const presence = frame.d?.presence ?? null;
    if (!presence || presence.userId !== session.userId) {
      return;
    }

    await supabase.from("presence").upsert(
      {
        user_id: presence.userId,
        status: presence.status === "invisible" ? "invisible" : presence.status,
        activities: presence.activities ?? [],
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );

    fanoutToUser(session.userId, "PRESENCE_UPDATE", { presence });
    await fanoutToFriends(session.userId, "PRESENCE_UPDATE", { presence });
    return;
  }

  if (frame.t === "SPOTIFY_UPDATE") {
    const payload = {
      userId: session.userId,
      status: frame.d?.status ?? "online",
      activity: frame.d?.activity ?? null,
      updatedAt: new Date().toISOString(),
    };

    fanoutToUser(session.userId, "SPOTIFY_UPDATE", payload);
    await fanoutToFriends(session.userId, "SPOTIFY_UPDATE", payload);
    return;
  }

  if (frame.t === "TYPING_START" || frame.t === "TYPING_STOP") {
    const conversationId = String(frame.d?.conversationId ?? "").trim();
    if (!conversationId) {
      return;
    }

    fanoutToTopic({ type: "conversation", id: conversationId }, frame.t, {
      conversationId,
      userId: session.userId,
      expiresAt: new Date(Date.now() + 5_000).toISOString(),
    });
  }
}

function disposeSocket(socket) {
  const session = sessionBySocket.get(socket);
  if (session) {
    const userSockets = socketsByUserId.get(session.userId);
    userSockets?.delete(socket);
    if (userSockets?.size === 0) {
      socketsByUserId.delete(session.userId);
    }
  }

  removeSocketFromTopics(socket);
  sessionBySocket.delete(socket);
  sockets.delete(socket);
}

wss.on("connection", (socket) => {
  sockets.add(socket);
  sendFrame(socket, "HELLO", null, {
    heartbeatIntervalMs: 15_000,
    connectionId: randomUUID(),
    serverTime: new Date().toISOString(),
  });

  socket.on("message", async (raw) => {
    const frame = parseFrame(raw);
    if (!frame?.op) {
      return;
    }

    if (frame.op === "IDENTIFY") {
      await attachSession(
        socket,
        String(frame.d?.token ?? ""),
        Array.isArray(frame.d?.subscriptions) ? frame.d.subscriptions : [],
      );
      return;
    }

    if (frame.op === "RESUME") {
      await attachSession(
        socket,
        String(frame.d?.token ?? ""),
        Array.isArray(frame.d?.subscriptions) ? frame.d.subscriptions : [],
        String(frame.d?.sessionId ?? "").trim() || null,
      );
      return;
    }

    if (frame.op === "HEARTBEAT") {
      sendFrame(socket, "HEARTBEAT_ACK", null, {
        acknowledgedAt: new Date().toISOString(),
      });
      return;
    }

    if (frame.op === "PING") {
      sendFrame(socket, "PONG", null, {
        acknowledgedAt: new Date().toISOString(),
      });
      return;
    }

    if (frame.op === "SUBSCRIBE") {
      const subscriptions = Array.isArray(frame.d?.subscriptions) ? frame.d.subscriptions : [];
      setSocketSubscriptions(socket, subscriptions);
      return;
    }

    if (frame.op === "PUBLISH") {
      await handleClientPublish(socket, frame);
    }
  });

  socket.on("close", () => {
    disposeSocket(socket);
  });

  socket.on("error", () => {
    disposeSocket(socket);
  });
});

const realtime = supabase
  .channel("messly-gateway-fanout")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "messages" },
    async (payload) => {
      const record = payload.new ?? payload.old;
      const conversationId = String(record?.conversation_id ?? "").trim();
      if (!conversationId) {
        return;
      }

      if (payload.eventType === "DELETE") {
        fanoutToTopic({ type: "conversation", id: conversationId }, "MESSAGE_DELETE", {
          conversationId,
          messageId: String(record?.id ?? ""),
          deletedAt: new Date().toISOString(),
        });
        return;
      }

      const senderId = String(record?.sender_id ?? "").trim();
      let profiles = [];
      if (senderId) {
        const profileResult = await supabase
          .from("profiles")
          .select("id,username,display_name,avatar_url,banner_url,bio,updated_at")
          .eq("id", senderId)
          .limit(1)
          .maybeSingle();

        if (profileResult.data) {
          profiles = [
            {
              id: profileResult.data.id,
              username: profileResult.data.username,
              displayName: profileResult.data.display_name,
              avatarUrl: profileResult.data.avatar_url,
              bannerUrl: profileResult.data.banner_url,
              bio: profileResult.data.bio,
              updatedAt: profileResult.data.updated_at,
            },
          ];
        }
      }

      fanoutToTopic(
        { type: "conversation", id: conversationId },
        payload.eventType === "INSERT" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE",
        {
          message: {
            id: String(record?.id ?? ""),
            conversationId,
            scopeType: "dm",
            scopeId: conversationId,
            senderId,
            clientId: record?.client_id ?? null,
            content: String(record?.content ?? ""),
            type: String(record?.type ?? "text"),
            createdAt: String(record?.created_at ?? new Date().toISOString()),
            editedAt: record?.edited_at ?? null,
            deletedAt: record?.deleted_at ?? null,
            replyToId: record?.reply_to_id ?? null,
            payload: record?.payload ?? null,
            attachment: record?.attachment ?? null,
            deliveryState: "sent",
            errorMessage: null,
          },
          profiles,
        },
      );
    },
  )
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "friend_requests" },
    (payload) => {
      const record = payload.new ?? payload.old;
      const requesterId = String(record?.requester_id ?? "").trim();
      const addresseeId = String(record?.addressee_id ?? "").trim();
      if (!requesterId || !addresseeId) {
        return;
      }

      const eventType = String(record?.status ?? "") === "accepted"
        ? "FRIEND_REQUEST_ACCEPT"
        : "FRIEND_REQUEST_CREATE";

      const dispatchPayload = {
        request: {
          id: String(record?.id ?? ""),
          requesterId,
          addresseeId,
          status: String(record?.status ?? "pending"),
          createdAt: record?.created_at ?? null,
        },
      };

      fanoutToUser(requesterId, eventType, dispatchPayload);
      fanoutToUser(addresseeId, eventType, dispatchPayload);
    },
  )
  .subscribe((status) => {
    if (status !== "SUBSCRIBED") {
      console.log("[gateway:realtime]", status);
    }
  });

server.listen(port, () => {
  console.log(`[messly-gateway] ws://localhost:${port}/gateway`);
});

process.on("SIGINT", async () => {
  await supabase.removeChannel(realtime);
  wss.close();
  server.close(() => {
    process.exit(0);
  });
});
