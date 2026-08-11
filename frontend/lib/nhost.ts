import { NhostClient } from '@nhost/nextjs';
import { createClient as createWSClient } from 'graphql-ws';
import { createClient, subscriptionExchange, cacheExchange, fetchExchange } from 'urql';

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
  const wsClient = createWSClient({
    url: process.env.NEXT_PUBLIC_HASURA_WS_URL || 'ws://localhost:8080/v1/graphql',
    connectionParams: () => {
      const token = nhost.auth.getAccessToken();
      return { headers: token ? { Authorization: `Bearer ${token}` } : {} };
    },
  });

  return createClient({
    url: process.env.NEXT_PUBLIC_HASURA_HTTP_URL || 'http://localhost:8080/v1/graphql',
    exchanges: [
      cacheExchange,
      fetchExchange,
      subscriptionExchange({
        forwardSubscription: (request) => ({
          subscribe: (sink) => ({
            unsubscribe: wsClient.subscribe(
              { ...request, query: request.query || '' },
              sink
            ),
          }),
        }),
      }),
    ],
    fetchOptions: () => {
      const token = nhost.auth.getAccessToken();
      return { headers: token ? { Authorization: `Bearer ${token}` } : {} };
    },
  });
}
