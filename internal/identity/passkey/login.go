package passkey

import (
	"context"
	"errors"
	"fmt"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

var (
	// ErrUnknownCredential means the sign-in assertion names a credential
	// that is not registered, or whose user handle does not match its owner,
	// or whose owner is no longer an active user.
	ErrUnknownCredential = errors.New("passkey: unknown credential")
	// ErrCloned means the assertion's signature counter did not advance past
	// the stored one: the authenticator may have been cloned.
	ErrCloned = errors.New("passkey: signature counter regressed (possible cloned authenticator)")
)

// Login runs the discoverable (username-less) passkey sign-in ceremony:
// Options starts it, Verify finishes it and resolves the user from the
// credential's user handle.
type Login struct {
	rp         *webauthn.WebAuthn
	challenges ChallengeStore
	q          *db.Queries
}

// NewLogin returns the sign-in ceremony over rp, with pending ceremonies in
// challenges and credentials in pool.
func NewLogin(rp *webauthn.WebAuthn, challenges ChallengeStore, pool db.DBTX) *Login {
	return &Login{rp: rp, challenges: challenges, q: db.New(pool)}
}

// Options starts a sign-in. email is an optional hint: when it names an
// active user with passkeys, allowCredentials lists them, so a browser
// without discoverable-credential support (or a security key) can still
// answer; otherwise the options are fully discoverable. It returns the
// challenge id to send back with Verify and the request options for
// navigator.credentials.get().
func (l *Login) Options(ctx context.Context, email string) (string, *protocol.CredentialAssertion, error) {
	var opts []webauthn.LoginOption
	if email != "" {
		allow, err := l.allowList(ctx, email)
		if err != nil {
			return "", nil, err
		}
		if len(allow) > 0 {
			opts = append(opts, webauthn.WithAllowedCredentials(allow))
		}
	}
	assertion, sd, err := l.rp.BeginDiscoverableLogin(opts...)
	if err != nil {
		return "", nil, fmt.Errorf("passkey: begin login: %w", err)
	}
	id, err := l.challenges.Put(ctx, CeremonyLogin, *sd)
	if err != nil {
		return "", nil, err
	}
	return id, assertion, nil
}

// allowList returns the credential descriptors of the active user with
// address email, or none when there is no such user.
func (l *Login) allowList(ctx context.Context, email string) ([]protocol.CredentialDescriptor, error) {
	u, err := l.q.GetUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("passkey: look up user: %w", err)
	}
	creds, err := l.q.ListPasskeyCredentialsForUser(ctx, u.ID)
	if err != nil {
		return nil, fmt.Errorf("passkey: list credentials: %w", err)
	}
	return webauthn.Credentials(newUser(u, creds).creds).CredentialDescriptors(), nil
}

// LoginResult is a verified passkey sign-in.
type LoginResult struct {
	User       db.User
	Credential db.PasskeyCredential
}

// Verify finishes the sign-in of challenge challengeID with response, the
// JSON-encoded PublicKeyCredential from navigator.credentials.get(). It
// consumes the challenge, resolves the user from the credential id and user
// handle, verifies the assertion and records the new signature counter,
// backup state and last use. It returns ErrChallengeNotFound for an unknown,
// expired or used challenge, ErrUnknownCredential for a credential that is
// not registered to an active user, ErrVerification for a response that does
// not verify and ErrCloned for a counter that went backwards. With
// ErrCloned the result still names the user and credential, for auditing.
func (l *Login) Verify(ctx context.Context, challengeID string, response []byte) (LoginResult, error) {
	sd, err := l.challenges.Take(ctx, CeremonyLogin, challengeID)
	if err != nil {
		return LoginResult{}, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(response)
	if err != nil {
		return LoginResult{}, fmt.Errorf("%w: %w", ErrVerification, err)
	}

	var (
		res       LoginResult
		lookupErr error
	)
	handler := func(rawID, userHandle []byte) (webauthn.User, error) {
		res, lookupErr = l.resolve(ctx, rawID, userHandle)
		if lookupErr != nil {
			return nil, lookupErr
		}
		creds, err := l.q.ListPasskeyCredentialsForUser(ctx, res.User.ID)
		if err != nil {
			lookupErr = fmt.Errorf("passkey: list credentials: %w", err)
			return nil, lookupErr
		}
		return newUser(res.User, creds), nil
	}
	cred, err := l.rp.ValidateDiscoverableLogin(handler, sd, parsed)
	if lookupErr != nil {
		return LoginResult{}, lookupErr
	}
	if err != nil {
		var unknown *protocol.ErrorUnknownCredential
		if errors.As(err, &unknown) {
			return LoginResult{}, fmt.Errorf("%w: %w", ErrUnknownCredential, err)
		}
		return LoginResult{}, fmt.Errorf("%w: %w", ErrVerification, err)
	}
	if cred.Authenticator.CloneWarning {
		return res, ErrCloned
	}

	n, err := l.q.UpdatePasskeySignCount(ctx, db.UpdatePasskeySignCountParams{
		ID:          res.Credential.ID,
		SignCount:   int64(cred.Authenticator.SignCount),
		BackupState: cred.Flags.BackupState,
	})
	if err != nil {
		return LoginResult{}, fmt.Errorf("passkey: update sign count: %w", err)
	}
	if n == 0 {
		// Removed between the lookup and now.
		return LoginResult{}, ErrUnknownCredential
	}
	res.Credential.SignCount = int64(cred.Authenticator.SignCount)
	res.Credential.BackupState = cred.Flags.BackupState
	return res, nil
}

// resolve finds the credential rawID and its active owner, and checks that
// the user handle the authenticator returned is that owner's id.
func (l *Login) resolve(ctx context.Context, rawID, userHandle []byte) (LoginResult, error) {
	c, err := l.q.GetPasskeyCredentialByCredentialID(ctx, rawID)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoginResult{}, ErrUnknownCredential
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("passkey: look up credential: %w", err)
	}
	handle, err := uuid.FromBytes(userHandle)
	if err != nil || handle != c.UserID {
		return LoginResult{}, ErrUnknownCredential
	}
	u, err := l.q.GetUserByID(ctx, c.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return LoginResult{}, ErrUnknownCredential
	}
	if err != nil {
		return LoginResult{}, fmt.Errorf("passkey: look up user: %w", err)
	}
	return LoginResult{User: u, Credential: c}, nil
}
