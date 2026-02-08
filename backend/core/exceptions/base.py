class AppError(Exception):
    """Base exception for all domain errors."""

    status_code: int = 500
    error_code: str = "internal_error"

    def __init__(self, message: str = "An unexpected error occurred"):
        self.message = message
        super().__init__(self.message)


class NotFoundError(AppError):
    status_code = 404
    error_code = "not_found"

    def __init__(self, message: str = "Resource not found"):
        super().__init__(message)


class AuthenticationError(AppError):
    status_code = 401
    error_code = "authentication_error"

    def __init__(self, message: str = "Authentication required"):
        super().__init__(message)


class TokenExpiredError(AuthenticationError):
    error_code = "token_expired"

    def __init__(self, message: str = "Token has expired"):
        super().__init__(message)


class TokenInvalidError(AuthenticationError):
    error_code = "token_invalid"

    def __init__(self, message: str = "Token is invalid"):
        super().__init__(message)


class RateLimitError(AppError):
    status_code = 429
    error_code = "rate_limit_exceeded"

    def __init__(self, message: str = "Too many requests"):
        super().__init__(message)


class ValidationError(AppError):
    status_code = 422
    error_code = "validation_error"

    def __init__(self, message: str = "Validation failed"):
        super().__init__(message)


class ConflictError(AppError):
    status_code = 409
    error_code = "conflict"

    def __init__(self, message: str = "Resource conflict"):
        super().__init__(message)
