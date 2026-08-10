'use client';

import { useState, useEffect } from 'react';
import { useAuthenticationStatus, useSignInEmailPassword, useUserData } from '@nhost/nextjs';
import { useQuery } from 'urql';
import Link from 'next/link';

const MY_ORGS = `
  query MyOrgs($userId: uuid!) {
    org_members(where: { user_id: { _eq: $userId } }) {
      role
      organization { id name }
    }
  }
`;

export default function Home() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const { isAuthenticated, isLoading } = useAuthenticationStatus();
  const user = useUserData();
  const { signInEmailPassword } = useSignInEmailPassword();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [{ data }] = useQuery({ query: MY_ORGS, variables: { userId: user?.id }, pause: !isAuthenticated });

  if (!mounted || isLoading) return <div className="container">Loading…</div>;

  if (!isAuthenticated) {
    return (
      <div className="container" style={{ maxWidth: 360 }}>
        <div className="eyebrow">AgentFlow</div>
        <h1>Sign in</h1>
        <div className="card" style={{ display: 'grid', gap: 10, marginTop: 16 }}>
          <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn btn-primary" onClick={() => signInEmailPassword(email, password)}>Sign in</button>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <div className="eyebrow">AgentFlow</div>
      <h1>Your organizations</h1>
      <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        {data?.org_members?.map((m: any) => (
          <Link key={m.organization.id} href={`/org/${m.organization.id}`} className="card" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{m.organization.name}</span>
            <span className="badge">{m.role}</span>
          </Link>
        ))}
        {data?.org_members?.length === 0 && <p style={{ color: 'var(--text-dim)' }}>You're not a member of any organization yet.</p>}
      </div>
    </div>
  );
}