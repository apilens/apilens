package apilens.authz

# Authorization policy for the APILens control plane (policy-as-code, CNCF OPA).
#
# Query: POST /v1/data/apilens/authz/allow with
#   {"input": {"user_id": "...", "action": "read|write|admin|delete",
#              "subject": {"role": "owner|admin|member|viewer"},
#              "resource": {"type": "project|app", "owner_id": "..."}}}
# Returns {"result": true|false}.
#
# RBAC: the control plane (PIP) resolves the subject's effective role on the
# resource and passes it in `input.subject.role`; this policy (PDP) maps that
# role to the set of permitted actions. The owner fallback keeps a resource's
# owner fully authorized even if role resolution is ever empty.

import rego.v1

default allow := false

# Role -> permitted actions (data-driven RBAC).
role_actions := {
	"owner": {"read", "write", "admin", "delete"},
	"admin": {"read", "write", "admin"},
	"member": {"read", "write"},
	"viewer": {"read"},
}

# Allow when the subject's role grants the requested action.
allow if {
	some action in role_actions[input.subject.role]
	action == input.action
}

# Defense-in-depth: the resource owner may perform any action on it.
allow if {
	input.user_id != ""
	input.resource.owner_id != ""
	input.user_id == input.resource.owner_id
}
