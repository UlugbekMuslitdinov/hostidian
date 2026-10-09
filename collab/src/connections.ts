import { documentNameFor, type ConnectionContext } from "./auth";

/** The slice of Hocuspocus this module touches (structural, so tests can fake it). */
export interface ConnectionRegistry {
  documents: Map<
    string,
    {
      connections: Map<
        {
          context: unknown;
          close(event?: { code: number; reason: string }): void;
          /** The socket the connection lives on (may carry other documents of the same client). */
          webSocket?: { close(code?: number, reason?: string): void };
        },
        unknown
      >;
    }
  >;
}

/** `ResetConnection` in @hocuspocus/common: tells the provider to drop its session and authenticate again. */
const RESET_CONNECTION_CODE = 4205;

export interface DisconnectCriteria {
  pageId?: string;
  userId?: string;
  reason: string;
}

/**
 * Closes live document connections that match every given criterion (page and/or user). Returns how many were closed.
 *
 * The document connection gets Hocuspocus' close message and then the WebSocket itself is closed: a provider whose
 * socket drops reconnects on its own and fetches a fresh collab token, so it picks up its new role (or is refused).
 * A bare close message would leave an unauthenticated, silent socket behind.
 */
export function closeMatchingConnections(registry: ConnectionRegistry, criteria: DisconnectCriteria): number {
  const documentName = criteria.pageId ? documentNameFor(criteria.pageId) : undefined;
  const userId = criteria.userId?.toLowerCase();
  let closed = 0;
  for (const [name, document] of registry.documents) {
    if (documentName && name !== documentName) continue;
    // Snapshot first: closing mutates the map.
    for (const connection of [...document.connections.keys()]) {
      const user = (connection.context as ConnectionContext | undefined)?.user;
      if (userId && user?.id !== userId) continue;
      const event = { code: RESET_CONNECTION_CODE, reason: criteria.reason };
      connection.close(event);
      try {
        connection.webSocket?.close(event.code, event.reason);
      } catch {
        // already closing
      }
      closed++;
    }
  }
  return closed;
}
