package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// TwoFactorPrefix is the path prefix of the 2FA endpoints.
const TwoFactorPrefix = AuthPrefix + "/2fa"

// TwoFactorService enables TOTP; *twofactor.Service satisfies it.
type TwoFactorService interface {
	Enable(ctx context.Context, user, sid uuid.UUID) (twofactor.Enrollment, error)
	Verify(ctx context.Context, user, sid uuid.UUID, code string) ([]string, error)
}

// TwoFactorEnableOutput is the response of POST /api/v1/auth/2fa/enable.
type TwoFactorEnableOutput struct {
	Body struct {
		Secret     string `json:"secret" doc:"Base32 TOTP secret, for typing into an authenticator app."`
		OTPAuthURI string `json:"otpauth_uri" doc:"otpauth:// key URI (issuer APILens, account the user's email), for rendering as a QR code."`
	}
}

// TwoFactorVerifyInput is the request of POST /api/v1/auth/2fa/verify.
type TwoFactorVerifyInput struct {
	Body struct {
		Code string `json:"code" minLength:"6" maxLength:"6" pattern:"^[0-9]{6}$" doc:"Current 6-digit code from the authenticator app."`
	}
}

// TwoFactorVerifyOutput is the response of POST /api/v1/auth/2fa/verify.
type TwoFactorVerifyOutput struct {
	Body struct {
		BackupCodes []string `json:"backup_codes" doc:"Ten single-use backup codes (xxxx-xxxx). They are shown this once and cannot be retrieved again."`
	}
}

// TwoFactor serves the endpoints that turn TOTP on.
type TwoFactor struct {
	svc    TwoFactorService
	logger *slog.Logger
}

// NewTwoFactor returns the 2FA endpoints over svc.
func NewTwoFactor(svc TwoFactorService, logger *slog.Logger) *TwoFactor {
	return &TwoFactor{svc: svc, logger: logger}
}

// Register mounts POST /api/v1/auth/2fa/enable and /verify. They declare the
// session scheme, so authn.Middleware must be installed on api before.
func (f *TwoFactor) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "enable-2fa",
		Method:      http.MethodPost,
		Path:        TwoFactorPrefix + "/enable",
		Summary:     "Start enabling two-factor authentication",
		Description: "Generates a TOTP secret (issuer `APILens`, account the user's email) and stores it encrypted and unconfirmed; returns the secret and its `otpauth://` URI for a QR code. Calling it again before `/2fa/verify` replaces the pending secret. Needs a sign-in less than 10 minutes old (`reauth_required` otherwise); answers `already_enabled` when 2FA is on.",
		Tags:        []string{server.TagAuth},
		Security:    security,
	}, CodeReauthRequired, CodeAlreadyEnabled, CodeUnauthenticated, CodeSessionExpired, CodeInternal), f.enable)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "verify-2fa",
		Method:      http.MethodPost,
		Path:        TwoFactorPrefix + "/verify",
		Summary:     "Confirm two-factor authentication",
		Description: "Checks a code from the authenticator app against the pending secret (one 30-second period of skew either way). On success 2FA is on: returns ten single-use backup codes, shown this once. Audited as `totp.enabled`; a security alert is emailed. Answers `invalid_totp` for a wrong code, `invalid_request` when `/2fa/enable` was not called and `already_enabled` when 2FA is already on.",
		Tags:        []string{server.TagAuth},
		Security:    security,
	}, CodeInvalidRequest, CodeInvalidTOTP, CodeAlreadyEnabled, CodeUnauthenticated, CodeSessionExpired, CodeInternal), f.verify)
}

func (f *TwoFactor) enable(ctx context.Context, _ *struct{}) (*TwoFactorEnableOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	e, err := f.svc.Enable(ctx, p.UserID, p.SessionID)
	if err != nil {
		return nil, f.fail(ctx, "enable 2fa", err)
	}
	out := &TwoFactorEnableOutput{}
	out.Body.Secret = e.Secret
	out.Body.OTPAuthURI = e.URI
	return out, nil
}

func (f *TwoFactor) verify(ctx context.Context, in *TwoFactorVerifyInput) (*TwoFactorVerifyOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	codes, err := f.svc.Verify(ctx, p.UserID, p.SessionID, in.Body.Code)
	if err != nil {
		return nil, f.fail(ctx, "verify 2fa", err)
	}
	out := &TwoFactorVerifyOutput{}
	out.Body.BackupCodes = codes
	return out, nil
}

// fail maps a service error to its problem. A user deleted while their
// access token is still valid answers session_expired.
func (f *TwoFactor) fail(ctx context.Context, op string, err error) error {
	switch {
	case errors.Is(err, twofactor.ErrReauthRequired):
		return Err(CodeReauthRequired)
	case errors.Is(err, twofactor.ErrAlreadyEnabled):
		return Err(CodeAlreadyEnabled)
	case errors.Is(err, twofactor.ErrInvalidCode):
		return Err(CodeInvalidTOTP)
	case errors.Is(err, twofactor.ErrNotPending):
		return Err(CodeInvalidRequest)
	case errors.Is(err, twofactor.ErrUserNotFound):
		return Err(CodeSessionExpired)
	case errors.Is(err, idkeys.ErrDecrypt):
		f.logger.ErrorContext(ctx, op+": cannot decrypt stored TOTP secret (wrong key encryption key?)")
		return Err(CodeInternal)
	default:
		f.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}
