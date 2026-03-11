import type { WebSocket } from "ws";
import type { SessionClientInfo } from "../sessions/sessionManager";

export interface ManagedConnection {
  connectionId: string;
  socket: WebSocket;
  userId: string;
  sessionId: string;
  shardId: number;
  ipAddress: string;
  accessToken: string;
  authSessionId: string;
  userAgent: string | null;
  client: SessionClientInfo | null;
  connectedAt: string;
}

export class ConnectionManager {
  private readonly bySocket = new Map<WebSocket, ManagedConnection>();

  add(connection: Omit<ManagedConnection, "connectedAt">): void {
    this.bySocket.set(connection.socket, {
      ...connection,
      connectedAt: new Date().toISOString(),
    });
  }

  get(socket: WebSocket): ManagedConnection | null {
    return this.bySocket.get(socket) ?? null;
  }

  remove(socket: WebSocket): ManagedConnection | null {
    const existing = this.bySocket.get(socket) ?? null;
    this.bySocket.delete(socket);
    return existing;
  }

  removeBySessionId(sessionId: string): void {
    for (const [socket, connection] of this.bySocket) {
      if (connection.sessionId === sessionId) {
        this.bySocket.delete(socket);
      }
    }
  }

  count(): number {
    return this.bySocket.size;
  }
}
