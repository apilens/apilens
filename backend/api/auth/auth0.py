# api/auth/auth0.py
from authlib.integrations.django_oauth2 import ResourceProtector
from authlib.oauth2.rfc7523 import JWTBearerTokenValidator
from authlib.jose import JsonWebKey
from urllib.request import urlopen
import json
from django.conf import settings

class Auth0JWTBearerTokenValidator(JWTBearerTokenValidator):
    def __init__(self, domain, audience):
        issuer = f"https://{domain}/"
        jwks = json.loads(
            urlopen(f"{issuer}.well-known/jwks.json").read()
        )
        public_key = JsonWebKey.import_key_set(jwks)
        super().__init__(public_key)
        self.claims_options = {
            "exp": {"essential": True},
            "aud": {"essential": True, "value": audience},
            "iss": {"essential": True, "value": issuer},
        }

require_auth = ResourceProtector()

validator = Auth0JWTBearerTokenValidator(
    settings.AUTH0_DOMAIN,
    settings.AUTH0_API_AUDIENCE,
)

require_auth.register_token_validator(validator)
