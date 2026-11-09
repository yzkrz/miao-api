package authz

const ResourceAudit = "audit"

var AuditRead = Permission{Resource: ResourceAudit, Action: ActionRead}

func init() {
	RegisterResource(ResourceDefinition{
		Resource: ResourceAudit,
		LabelKey: "Audit Logs",
		Actions: []ActionDefinition{{
			Action:         ActionRead,
			LabelKey:       "View other accounts' audit logs",
			DescriptionKey: "View user and admin audit records, and manage their API keys, usage limits, concurrency, and window resets, including your own. Root accounts are excluded.",
		}},
	})
}
