package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	idkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/twofactor"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// TwoFactorPrefix is the path prefix of the 2FA endpoints.
const TwoFactorPrefix = AuthPrefix + "/2fa"

// TwoFactorService enables and manages TOTP; *twofactor.Service satisfies
// it.
type TwoFactorService interface {
	Enable(ctx context.Context, user, sid uuid.UUID) (twofactor.Enrollment, error)
	Verify(ctx context.Context, user, sid uuid.UUID, code string) ([]string, error)
	Status(ctx context.Context, user, sid uuid.UUID) (twofactor.Status, error)
	Disable(ctx context.Context, user, sid uuid.UUID, p twofactor.Proof) error
	RegenerateBackupCodes(ctx context.Context, user, sid uuid.UUID, code string) ([]string, error)
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

// TwoFactorStatusOutput is the response of GET /api/v1/auth/2fa/status.
type TwoFactorStatusOutput struct {
	Body struct {
		Enabled              bool       `json:"enabled" doc:"Whether two-factor authentication is on. A secret pending confirmation counts as off."`
		ConfirmedAt          *time.Time `json:"confirmed_at" nullable:"true" doc:"When two-factor authentication was turned on, or null when it is off."`
		BackupCodesRemaining int        `json:"backup_codes_remaining" minimum:"0" doc:"Unused backup codes left; 0 when two-factor authentication is off."`
	}
}

// TwoFactorDisableInput is the request of POST /api/v1/auth/2fa/disable.
type TwoFactorDisableInput struct {
	Body struct {
		Code       string `json:"code,omitempty" required:"false" pattern:"^[0-9]{6}$" doc:"Current 6-digit code from the authenticator app. Send this or backup_code, not both."`
		BackupCode string `json:"backup_code,omitempty" required:"false" minLength:"1" maxLength:"32" doc:"An unused backup code (xxxx-xxxx; case, dashes and spaces are ignored). Send this or code, not both."`
	}
}

// TwoFactorRegenerateInput is the request of POST
// /api/v1/auth/2fa/backup-codes/regenerate.
type TwoFactorRegenerateInput struct {
	Body struct {
		Code string `json:"code" minLength:"6" maxLength:"6" pattern:"^[0-9]{6}$" doc:"Current 6-digit code from the authenticator app."`
	}
}

// TwoFactor serves the endpoints that turn TOTP on and manage it.
type TwoFactor struct {
	svc    TwoFactorService
	logger *slog.Logger
}

// NewTwoFactor returns the 2FA endpoints over svc.
func NewTwoFactor(svc TwoFactorService, logger *slog.Logger) *TwoFactor {
	return &TwoFactor{svc: svc, logger: logger}
}

// Register mounts POST /api/v1/auth/2fa/enable, /verify, /disable and
// /backup-codes/regenerate and GET /api/v1/auth/2fa/status. They declare the
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

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "get-2fa-status",
		Method:      http.MethodGet,
		Path:        TwoFactorPrefix + "/status",
		Summary:     "Get two-factor authentication status",
		Description: "Whether two-factor authentication is on, since when, and how many unused backup codes are left. Needs a current session (`session_expired` when it was revoked or has expired).",
		Tags:        []string{server.TagAuth},
		Security:    security,
	}, CodeUnauthenticated, CodeSessionExpired, CodeInternal), f.status)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID:   "disable-2fa",
		Method:        http.MethodPost,
		Path:          TwoFactorPrefix + "/disable",
		DefaultStatus: http.StatusNoContent,
		Summary:       "Turn off two-factor authentication",
		Description:   "Needs a fresh second factor: exactly one of a code from the authenticator app (`code`) or an unused backup code (`backup_code`), `invalid_request` otherwise. Deletes the TOTP secret and every backup code. Audited as `totp.disabled`; a security alert is emailed. Answers `invalid_totp` for a wrong code or a wrong or spent backup code and `not_enabled` when 2FA is off.",
		Tags:          []string{server.TagAuth},
		Security:      security,
	}, CodeInvalidRequest, CodeInvalidTOTP, CodeNotEnabled, CodeUnauthenticated, CodeSessionExpired, CodeInternal), f.disable)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "regenerate-2fa-backup-codes",
		Method:      http.MethodPost,
		Path:        TwoFactorPrefix + "/backup-codes/regenerate",
		Summary:     "Regenerate backup codes",
		Description: "Needs a fresh code from the authenticator app. Replaces the backup codes: every old code stops working and ten new single-use codes are returned, shown this once. A security alert is emailed. Answers `invalid_totp` for a wrong code and `not_enabled` when 2FA is off.",
		Tags:        []string{server.TagAuth},
		Security:    security,
	}, CodeInvalidTOTP, CodeNotEnabled, CodeUnauthenticated, CodeSessionExpired, CodeInternal), f.regenerate)
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

func (f *TwoFactor) status(ctx context.Context, _ *struct{}) (*TwoFactorStatusOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	st, err := f.svc.Status(ctx, p.UserID, p.SessionID)
	if err != nil {
		return nil, f.fail(ctx, "2fa status", err)
	}
	out := &TwoFactorStatusOutput{}
	out.Body.Enabled = st.Enabled
	out.Body.ConfirmedAt = st.ConfirmedAt
	out.Body.BackupCodesRemaining = st.BackupCodesRemaining
	return out, nil
}

func (f *TwoFactor) disable(ctx context.Context, in *TwoFactorDisableInput) (*struct{}, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	proof := twofactor.Proof{Code: in.Body.Code, BackupCode: in.Body.BackupCode}
	if err := f.svc.Disable(ctx, p.UserID, p.SessionID, proof); err != nil {
		return nil, f.fail(ctx, "disable 2fa", err)
	}
	return nil, nil
}

func (f *TwoFactor) regenerate(ctx context.Context, in *TwoFactorRegenerateInput) (*TwoFactorVerifyOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	codes, err := f.svc.RegenerateBackupCodes(ctx, p.UserID, p.SessionID, in.Body.Code)
	if err != nil {
		return nil, f.fail(ctx, "regenerate backup codes", err)
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
	case errors.Is(err, twofactor.ErrNotPending), errors.Is(err, twofactor.ErrProofRequired):
		return Err(CodeInvalidRequest)
	case errors.Is(err, twofactor.ErrNotEnabled):
		return Err(CodeNotEnabled)
	case errors.Is(err, twofactor.ErrUserNotFound), errors.Is(err, twofactor.ErrSessionEnded):
		return Err(CodeSessionExpired)
	case errors.Is(err, idkeys.ErrDecrypt):
		f.logger.ErrorContext(ctx, op+": cannot decrypt stored TOTP secret (wrong key encryption key?)")
		return Err(CodeInternal)
	default:
		f.logger.ErrorContext(ctx, op, "error", err)
		return Err(CodeInternal)
	}
}
