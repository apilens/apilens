'use client'

import { Auth0Provider } from '@auth0/auth0-react'
import { useRouter } from 'next/navigation'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  const domain = process.env.NEXT_PUBLIC_AUTH0_DOMAIN!
  const clientId = process.env.NEXT_PUBLIC_AUTH0_CLIENT_ID!
  const redirectUri = typeof window !== 'undefined' ? window.location.origin : ''

  const onRedirectCallback = (appState: any) => {
    router.push(appState?.returnTo || '/dashboard')
  }

  return (
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      authorizationParams={{
        redirect_uri: redirectUri,
      }}
      onRedirectCallback={onRedirectCallback}
      cacheLocation="localstorage"
    >
      {children}
    </Auth0Provider>
  )
}
