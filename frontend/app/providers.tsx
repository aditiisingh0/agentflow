'use client';

import { NhostProvider } from '@nhost/nextjs';
import { Provider as UrqlProvider } from 'urql';
import { useMemo } from 'react';
import { nhost, makeUrqlClient } from '../lib/nhost';

export default function Providers({ children }: { children: React.ReactNode }) {
  const urqlClient = useMemo(() => makeUrqlClient(), []);
  return (
    <NhostProvider nhost={nhost}>
      <UrqlProvider value={urqlClient}>{children}</UrqlProvider>
    </NhostProvider>
  );
}
