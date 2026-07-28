import type { Metadata } from 'next'
import { Suspense } from 'react'
import '@/styles/index.css'
import { QueryProvider } from '@/providers/QueryProvider'
import { AuthProvider } from '@/providers/AuthProvider'
import { ProjectProvider } from '@/providers/ProjectProvider'
import { ToastProvider, AlertProvider } from '@/components/ui'
import { AppLayout } from '@/components/layout'
import { ThemeDbBridge } from '@/components/ThemeDbBridge'
import { resolveWsHint } from '@/hooks/agentWsUrl'

export const metadata: Metadata = {
  title: 'RedAmon',
  description: 'Security reconnaissance and vulnerability assessment dashboard',
  icons: {
    icon: '/favicon.ico',
    apple: '/favicon.png',
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Browser->agent WebSocket routing hint, resolved at REQUEST time (no rebuild)
  // and read by buildAgentWsUrl(). Default deploy has no reverse proxy, so tell the
  // UI to dial the agent's published port on whatever host the browser used, fixing
  // LAN/remote "Connecting…" (issue #159). A reverse-proxied deploy sets
  // AGENT_WS_PUBLIC_URL (or bakes NEXT_PUBLIC_AGENT_WS_URL) and stays same-origin.
  const wsHint = resolveWsHint(process.env)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {wsHint && (
          <script
            dangerouslySetInnerHTML={{
              // Escape `<` so a misconfigured env value can never break out of the
              // <script> tag (JSON.stringify does not escape `/`, so `</script>`
              // would otherwise terminate it). The value is trusted server env, but
              // this keeps the injection XSS-safe by construction.
              __html: `window.__REDAMON_WS__=${JSON.stringify(wsHint).replace(/</g, '\\u003c')};`,
            }}
          />
        )}
        {/* Prevent flash of wrong theme */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var theme = localStorage.getItem('redamon-theme');
                  if (theme === 'dark' || theme === 'light') {
                    document.documentElement.setAttribute('data-theme', theme);
                  } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
                    document.documentElement.setAttribute('data-theme', 'light');
                  } else {
                    document.documentElement.setAttribute('data-theme', 'dark');
                  }
                } catch (e) {
                  document.documentElement.setAttribute('data-theme', 'dark');
                }
              })();
            `,
          }}
        />
      </head>
      <body>
        <QueryProvider>
          <Suspense fallback={null}>
            <AuthProvider>
              <ThemeDbBridge />
              <ProjectProvider>
                <ToastProvider>
                  <AlertProvider>
                    <AppLayout>{children}</AppLayout>
                  </AlertProvider>
                </ToastProvider>
              </ProjectProvider>
            </AuthProvider>
          </Suspense>
        </QueryProvider>
      </body>
    </html>
  )
}
