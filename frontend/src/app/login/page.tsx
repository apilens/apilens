'use client'

import { useAuth0 } from '@auth0/auth0-react'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const { loginWithRedirect, isAuthenticated, isLoading } = useAuth0()
  const router = useRouter()

  useEffect(() => {
    if (isLoading) return

    if (isAuthenticated) {
      router.replace('/')
    } else {
      loginWithRedirect()
    }
  }, [isLoading, isAuthenticated, loginWithRedirect, router])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-gray-900 border-t-transparent" />
    </div>
  )
}
