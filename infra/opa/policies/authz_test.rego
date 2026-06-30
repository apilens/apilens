package apilens.authz

import rego.v1

_in(role, action, owner_id, user_id) := {
	"user_id": user_id,
	"action": action,
	"subject": {"role": role},
	"resource": {"type": "project", "owner_id": owner_id},
}

test_owner_can_delete if {
	allow with input as _in("owner", "delete", "x", "u1")
}

test_admin_can_admin if {
	allow with input as _in("admin", "admin", "x", "u1")
}

test_admin_cannot_delete if {
	not allow with input as _in("admin", "delete", "x", "u1")
}

test_member_can_write if {
	allow with input as _in("member", "write", "x", "u1")
}

test_member_cannot_admin if {
	not allow with input as _in("member", "admin", "x", "u1")
}

test_viewer_can_read if {
	allow with input as _in("viewer", "read", "x", "u1")
}

test_viewer_cannot_write if {
	not allow with input as _in("viewer", "write", "x", "u1")
}

# No membership role and not the owner → no access.
test_no_role_no_access if {
	not allow with input as _in("", "read", "other", "u1")
}

# Owner fallback: the resource owner is authorized even with an empty role.
test_owner_fallback if {
	allow with input as _in("", "delete", "u1", "u1")
}
