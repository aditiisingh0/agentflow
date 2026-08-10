import './globals.css';
import Providers from './providers';

export const metadata = {
  title: 'AgentFlow — AI Agent Workflow Builder',
  description: 'Chain AI agent steps into workflows with org-scoped permissions and live run tracking.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
