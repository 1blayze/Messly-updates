import type { WebSocket } from "ws";
import type { SessionClientInfo } from "../sessions/sessionManager";
import type { GatewaySubscription } from "../protocol/dispatch";

export interface LocalGatewayConnection {
  connectionId: string;
  socket: WebSocket;
  sessionId: string | null;
  userId: string | null;
  authSessionId: string | null;
  ipAddress: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
  subscriptions: GatewaySubscription[];
  connectedAt: number;
  lastHeartbeatAt: number;
}

function topicKey(subscription: GatewaySubscription): string {
  return `${subscription.type}:${subscription.id}`;
}

export class ConnectionRegistry {
  private readonly bySocket = new Map<WebSocket, LocalGatewayConnection>();
  private readonly byConnectionId = new Map<string, LocalGatewayConnection>();
  private readonly bySessionId = new Map<string, LocalGatewayConnection>();
  private readonly connectionIdsByTopic = new Map<string, Set<string>>();

  add(connection: Omit<LocalGatewayConnection, "connectedAt" | "lastHeartbeatAt">): LocalGatewayConnection {
    const nextConnection: LocalGatewayConnection = {
      ...connection,
      connectedAt: Date.now(),
      lastHeartbeatAt: Date.now(),
    };
    this.bySocket.set(connection.socket, nextConnection);
    this.byConnectionId.set(connection.connectionId, nextConnection);
    if (nextConnection.sessionId) {
      this.bySessionId.set(nextConnection.sessionId, nextConnection);
    }
    this.indexSubscriptions(nextConnection.connectionId, nextConnection.subscriptions);
    return nextConnection;
  }

  getBySocket(socket: WebSocket): LocalGatewayConnection | null {
    return this.bySocket.get(socket) ?? null;
  }

  getByConnectionId(connectionId: string): LocalGatewayConnection | null {
    return this.byConnectionId.get(connectionId) ?? null;
  }

  getBySessionId(sessionId: string): LocalGatewayConnection | null {
    return this.bySessionId.get(sessionId) ?? null;
  }

  attachSession(connectionId: string, session: {
    sessionId: string;
    userId: string;
    authSessionId: string;
    subscriptions: GatewaySubscription[];
    client: SessionClientInfo | null;
  }): LocalGatewayConnection | null {
    const connection = this.byConnectionId.get(connectionId);
    if (!connection) {
      return null;
    }
    if (connection.sessionId && connection.sessionId !== session.sessionId) {
      this.bySessionId.delete(connection.sessionId);
    }
    connection.sessionId = session.sessionId;
    connection.userId = session.userId;
    connection.authSessionId = session.authSessionId;
    connection.client = session.client;
    this.replaceSubscriptions(connectionId, session.subscriptions);
    this.bySessionId.set(session.sessionId, connection);
    connection.lastHeartbeatAt = Date.now();
    return connection;
  }

  replaceSubscriptions(connectionId: string, subscriptions: GatewaySubscription[]): void {
    const connection = this.byConnectionId.get(connectionId);
    if (!connection) {
      return;
    }
    this.unindexSubscriptions(connectionId, connection.subscriptions);
    connection.subscriptions = subscriptions;
    this.indexSubscriptions(connectionId, subscriptions);
  }

  touchHeartbeat(connectionId: string): void {
    const connection = this.byConnectionId.get(connectionId);
    if (!connection) {
      return;
    }
    connection.lastHeartbeatAt = Date.now();
  }

  remove(socket: WebSocket): LocalGatewayConnection | null {
    const connection = this.bySocket.get(socket) ?? null;
    if (!connection) {
      return null;
    }
    this.bySocket.delete(socket);
    this.byConnectionId.delete(connection.connectionId);
    if (connection.sessionId && this.bySessionId.get(connection.sessionId)?.connectionId === connection.connectionId) {
      this.bySessionId.delete(connection.sessionId);
    }
    this.unindexSubscriptions(connection.connectionId, connection.subscriptions);
    return connection;
  }

  matchSubscriptions(subscriptions: GatewaySubscription[]): LocalGatewayConnection[] {
    const connectionIds = new Set<string>();
    subscriptions.forEach((subscription) => {
      this.connectionIdsByTopic.get(topicKey(subscription))?.forEach((connectionId) => {
        connectionIds.add(connectionId);
      });
    });
    return [...connectionIds]
      .map((connectionId) => this.byConnectionId.get(connectionId))
      .filter((connection): connection is LocalGatewayConnection => Boolean(connection));
  }

  listConnections(): LocalGatewayConnection[] {
    return [...this.byConnectionId.values()];
  }

  count(): number {
    return this.byConnectionId.size;
  }

  private indexSubscriptions(connectionId: string, subscriptions: GatewaySubscription[]): void {
    subscriptions.forEach((subscription) => {
      const key = topicKey(subscription);
      const connectionIds = this.connectionIdsByTopic.get(key) ?? new Set<string>();
      connectionIds.add(connectionId);
      this.connectionIdsByTopic.set(key, connectionIds);
    });
  }

  private unindexSubscriptions(connectionId: string, subscriptions: GatewaySubscription[]): void {
    subscriptions.forEach((subscription) => {
      const key = topicKey(subscription);
      const connectionIds = this.connectionIdsByTopic.get(key);
      connectionIds?.delete(connectionId);
      if (!connectionIds || connectionIds.size === 0) {
        this.connectionIdsByTopic.delete(key);
      }
    });
  }
}
