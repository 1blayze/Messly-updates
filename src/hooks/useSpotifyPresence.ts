import { useEffect, useState } from "react";
import {
  readSpotifyConnection,
  subscribeSpotifyConnection,
  type SpotifyConnectionState,
} from "../services/connections/spotifyConnection";

interface UseSpotifyPresenceOptions {
  enablePolling?: boolean;
}

export function useSpotifyPresence(
  scope: string | null | undefined,
  options: UseSpotifyPresenceOptions = {},
): SpotifyConnectionState {
  const enablePolling = options.enablePolling === true;
  const [connection, setConnection] = useState<SpotifyConnectionState>(() => readSpotifyConnection(scope));

  useEffect(() => {
    setConnection(readSpotifyConnection(scope));
    return subscribeSpotifyConnection(scope, setConnection, { enablePolling });
  }, [enablePolling, scope]);

  return connection;
}

export default useSpotifyPresence;
