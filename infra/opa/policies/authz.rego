package apilens.authz

# Authorization policy for the APILens control plane (policy-as-code, CNCF OPA).
#
# Query: POST /v1/data/apilens/authz/allow with
#   {"input": {"user_id": "...", "action": "read|write|admin",
#              "resource": {"type": "project|app", "owner_id": "..."}}}
# Returns {"result": true|false}.
#
# Today this mirrors the ownership model (you may act on resources your account
# owns). It is intentionally structured so roles/teams/sharing can be added here
# — in the policy — without changing service code.

import rego.v1

default allow := false

# The resource owner may perform any action on it.
allow if {
	input.user_id != ""
	input.resource.owner_id != ""
	input.user_id == input.resource.owner_id
}
