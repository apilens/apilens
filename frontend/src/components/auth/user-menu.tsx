'use client'

import { useAuth0 } from '@auth0/auth0-react'
import { Button } from '@/components/ui/button'

export function UserMenu() {
  const { user, logout, isLoading } = useAuth0()

  if (isLoading) {
    return <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />
  }

  return (
    <div className="flex items-center gap-3">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => logout({ logoutParams: { returnTo: window.location.origin } })}
      >
        Log out
      </Button>
      {user?.picture ? (
        <img
          src={user.picture}
          alt={user.name || 'User'}
          className="h-8 w-8 rounded-full"
        />
      ) : (
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-sm font-medium">
          {user?.name?.charAt(0).toUpperCase() || 'U'}
        </div>
      )}
    </div>
  )
}
