'use client'

import { useAuth0 } from '@auth0/auth0-react'
import { useEffect } from 'react'

export default function LogoutPage() {
  const { logout, isLoading } = useAuth0()

  useEffect(() => {
    if (!isLoading) {
      logout({ logoutParams: { returnTo: window.location.origin } })
    }
  }, [isLoading, logout])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-900 border-t-transparent" />
    </div>
  )
}
