function withId(prefix: string, id: string): string {
  return `${prefix}:${id}`;
}

export const gatewayRedisKeys = {
  session: (sessionId: string) => withId("messly:gateway:session", sessionId),
  sessionEvents: (sessionId: string) => withId("messly:gateway:session-events", sessionId),
  userSessions: (userId: string) => withId("messly:gateway:user-sessions", userId),
  rateLimit: (bucket: string) => withId("messly:gateway:rate-limit", bucket),
  presenceSession: (sessionId: string) => withId("messly:gateway:presence:session", sessionId),
  presenceUserSessions: (userId: string) => withId("messly:gateway:presence:user-sessions", userId),
  lease: (name: string) => withId("messly:gateway:lease", name),
};
