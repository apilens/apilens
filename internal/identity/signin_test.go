package identity

import (
	"encoding/json"
	"testing"
)

// TestSignInResponseKeepsRememberFalse guards the OAuth/SSO handoff: the UI
// sets its cookie from this field, so an unticked "keep me signed in" must
// reach it as false rather than be omitted (and read back as the default).
func TestSignInResponseKeepsRememberFalse(t *testing.T) {
	body, err := json.Marshal(SignInResponse{AccessToken: "a", Remember: false})
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if v, ok := got["remember"]; !ok || v != false {
		t.Fatalf("remember = %v (present %v) in %s", v, ok, body)
	}
}
