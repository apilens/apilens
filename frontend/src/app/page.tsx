'use client'

import { useAuth0 } from '@auth0/auth0-react'
import { useEffect } from 'react'

export default function HomePage() {
  const { user, isAuthenticated, isLoading, loginWithRedirect, logout } = useAuth0()

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      loginWithRedirect()
    }
  }, [isLoading, isAuthenticated, loginWithRedirect])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-900 border-t-transparent" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-6">
          <span className="text-base font-semibold tracking-tight">ApiLens</span>
          <div className="flex items-center gap-4">
            <span className="text-sm text-neutral-500">{user?.email}</span>
            <button
              onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
              className="text-sm text-neutral-500 hover:text-neutral-900 transition-colors"
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold text-neutral-900">Welcome, {user?.name || 'User'}</h1>
        <p className="mt-1 text-neutral-500">You're logged in to ApiLens.</p>
      </main>
    </div>
  )
}
