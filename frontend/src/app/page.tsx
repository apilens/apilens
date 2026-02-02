'use client'

import { useAuth0 } from '@auth0/auth0-react'
import { useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { UserMenu } from '@/components/auth/user-menu'

const projects = [
  { name: 'ApiLens-web', status: 'Ready', updated: '2 hours ago' },
  { name: 'ApiLens-api', status: 'Building', updated: '5 minutes ago' },
  { name: 'ApiLens-docs', status: 'Ready', updated: '1 day ago' },
]

const stats = [
  { label: 'Deployments', value: '142' },
  { label: 'Bandwidth', value: '24.5 GB' },
  { label: 'Requests', value: '1.2M' },
]

export default function DashboardPage() {
  const { isAuthenticated, isLoading, loginWithRedirect } = useAuth0()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      loginWithRedirect()
    }
  }, [isLoading, isAuthenticated, loginWithRedirect])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-foreground border-t-transparent" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              ApiLens
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link href="/" className="font-medium">
                Projects
              </Link>
              <Link href="/settings" className="text-muted-foreground hover:text-foreground">
                Settings
              </Link>
            </nav>
          </div>
          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="grid gap-4 md:grid-cols-3">
          {stats.map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-2">
                <span className="text-sm text-muted-foreground">{stat.label}</span>
              </CardHeader>
              <CardContent>
                <span className="text-2xl font-semibold">{stat.value}</span>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium">Projects</h2>
            <Button size="sm">New Project</Button>
          </div>
          <div className="mt-4 space-y-2">
            {projects.map((project) => (
              <Card key={project.name} className="transition-colors hover:bg-muted/50">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                      <span className="text-sm font-medium">
                        {project.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div>
                      <h3 className="font-medium">{project.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        Updated {project.updated}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span
                      className={`flex items-center gap-1.5 text-sm ${
                        project.status === 'Ready' ? 'text-green-600' : 'text-yellow-600'
                      }`}
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          project.status === 'Ready' ? 'bg-green-600' : 'bg-yellow-600'
                        }`}
                      />
                      {project.status}
                    </span>
                    <Button variant="ghost" size="sm">
                      Visit
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>

        <div className="mt-8">
          <h2 className="text-lg font-medium">Quick Actions</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Card className="cursor-pointer transition-colors hover:bg-muted/50">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium">Import Repository</h3>
                  <p className="text-sm text-muted-foreground">Connect your Git repository</p>
                </div>
              </CardContent>
            </Card>
            <Card className="cursor-pointer transition-colors hover:bg-muted/50">
              <CardContent className="flex items-center gap-4 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-medium">Configure Settings</h3>
                  <p className="text-sm text-muted-foreground">Manage your account</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  )
}
