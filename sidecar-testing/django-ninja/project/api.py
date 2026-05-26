from ninja import NinjaAPI

api = NinjaAPI(title="API Lens Sidecar - Django Ninja")


@api.get("/health")
def health(request):
    return {"status": "ok", "framework": "django-ninja"}


@api.get("/v1/users/{user_id}")
def get_user(request, user_id: str):
    return {"user_id": user_id, "status": "fetched"}
