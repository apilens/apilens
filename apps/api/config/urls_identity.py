"""URLconf for the bounded **identity** service (auth.apilens.ai).

Serves ONLY the identity/auth surface — no projects/users. Selected via
ROOT_URLCONF=config.urls_identity in the identity container.

Layout:
  /.well-known/openid-configuration   OIDC discovery (at the issuer root)
  /.well-known/jwks.json              public verification keys (root)
  /v1/*                               the identity API (magic-link, passkey,
                                      2FA, tokens, introspect, docs, livez/readyz)

The legacy path api.apilens.ai/api/v1/auth/* is preserved by a Caddy rewrite
(/api/v1/auth -> /v1) so existing clients keep working during the cutover.
"""

from django.conf import settings
from django.http import JsonResponse
from django.urls import path

from routers.router import identity_api
from core.auth import keys


def _discovery(request):
    return JsonResponse(keys.openid_configuration(getattr(settings, "JWT_ISSUER", "https://auth.apilens.ai")))


def _jwks(request):
    return JsonResponse(keys.jwks())


urlpatterns = [
    path(".well-known/openid-configuration", _discovery),
    path(".well-known/jwks.json", _jwks),
    path("v1/", identity_api.urls),
]
