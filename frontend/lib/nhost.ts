import { NhostClient } from '@nhost/nextjs';
import { createClient, subscriptionExchange, cacheExchange, fetchExchange } from 'urql';
import { print } from 'graphql';

export const nhost = new NhostClient({
  authUrl: process.env.NEXT_PUBLIC_NHOST_AUTH_URL || 'http://localhost:4000',
  graphqlUrl: process.env.NEXT_PUBLIC_NHOST_GRAPHQL_URL || 'http://localhost:8080/v1/graphql',
  functionsUrl: process.env.NEXT_PUBLIC_NHOST_FUNCTIONS_URL || 'http://localhost:3001/v1/functions',
  storageUrl: process.env.NEXT_PUBLIC_NHOST_STORAGE_URL || 'http://localhost:8000/v1',
});

// urql client wired for queries/mutations over HTTP and live subscriptions
// over websocket, both carrying the user's nhost JWT so Hasura applies the
// `user` role permissions (org+role scoping) we defined in metadata.
export function makeUrqlClient() {
  // Hasura/Nhost exposes the established `graphql-ws` WebSocket protocol.
  // The similarly named `graphql-ws` npm package implements the newer
  // `graphql-transport-ws` protocol; mixing them makes Hasura close a live
  // subscription with "no subscriptions exist". Keep this tiny adapter here
  // so the production client speaks the protocol Hasura expects.
  const legacySubscriptionExchange = subscriptionExchange({
    forwardSubscription: (request) => ({
      subscribe: (sink) => {
        const configuredUrl = process.env.NEXT_PUBLIC_HASURA_WS_URL;
        const httpUrl = process.env.NEXT_PUBLIC_HASURA_HTTP_URL;
        const url = (configuredUrl || httpUrl || 'ws://localhost:8080/v1/graphql')
          .replace(/^http/, 'ws');
        const operationId = crypto.randomUUID();
        let closed = false;
        let completed = false;
        const socket = new WebSocket(url, 'graphql-ws');

        socket.onopen = () => {
          const token = nhost.auth.getAccessToken();
          socket.send(JSON.stringify({
            type: 'connection_init',
            payload: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
          }));
        };

        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'connection_ack') {
            socket.send(JSON.stringify({
              id: operationId,
              type: 'start',
              payload: {
                query: typeof request.query === 'string' ? request.query : print(request.query),
                variables: request.variables,
              },
            }));
          } else if (message.type === 'data') {
            sink.next(message.payload);
          } else if (message.type === 'error' || message.type === 'connection_error') {
            sink.error(message.payload);
          } else if (message.type === 'complete') {
            completed = true;
            sink.complete();
          }
        };

        socket.onerror = () => {
          if (!closed) sink.error(new Error('Live updates connection failed.'));
        };
        socket.onclose = () => {
          if (!closed && !completed) sink.error(new Error('Live updates connection closed.'));
        };

        return {
          unsubscribe: () => {
            closed = true;
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ id: operationId, type: 'stop' }));
            }
            socket.close();
          },
        };
      },
    }),
  });

  return createClient({
    url: process.env.NEXT_PUBLIC_HASURA_HTTP_URL || 'http://localhost:8080/v1/graphql',
    exchanges: [
      cacheExchange,
      fetchExchange,
      legacySubscriptionExchange,
    ],
    fetchOptions: () => {
      const token = nhost.auth.getAccessToken();
      return { headers: token ? { Authorization: `Bearer ${token}` } : {} };
    },
  });
}
