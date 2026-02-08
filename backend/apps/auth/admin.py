from django.contrib import admin

from .models import ApiKey, RefreshToken, MagicLinkToken


@admin.register(RefreshToken)
class RefreshTokenAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "user",
        "device_info",
        "ip_address",
        "is_revoked",
        "expires_at",
        "last_used_at",
        "created_at",
    ]
    list_filter = ["is_revoked", "created_at"]
    search_fields = ["user__email", "device_info", "ip_address"]
    readonly_fields = ["id", "token_hash", "token_family", "created_at", "last_used_at"]
    raw_id_fields = ["user"]


@admin.register(MagicLinkToken)
class MagicLinkTokenAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "email",
        "is_used",
        "ip_address",
        "expires_at",
        "created_at",
    ]
    list_filter = ["is_used", "created_at"]
    search_fields = ["email"]
    readonly_fields = ["id", "token_hash", "created_at"]


@admin.register(ApiKey)
class ApiKeyAdmin(admin.ModelAdmin):
    list_display = [
        "id",
        "user",
        "name",
        "prefix",
        "is_revoked",
        "last_used_at",
        "created_at",
    ]
    list_filter = ["is_revoked", "created_at"]
    search_fields = ["user__email", "name", "prefix"]
    readonly_fields = ["id", "key_hash", "prefix", "created_at"]
    raw_id_fields = ["user"]
