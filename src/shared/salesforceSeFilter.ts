// Salesforce "my Opportunities" search (v1.474.0). The default Opportunity
// search lists the Opportunities a contributor owns plus any where they sit in
// one of the Opportunity fields the team maps to this app field in CRM Field
// Mappings. Orgs name these fields themselves (an Assigned SE lookup, a
// Supporting Engineers multi-select, ...), so nothing here assumes one: with
// none mapped the search falls back to the Opportunity owner alone. The
// HubSpot counterpart is HUBSPOT_SE_FILTER_APP_FIELD (shared/hubspot.ts).
export const SF_SE_FILTER_APP_FIELD = 'opp_se_filter'

// Field types the filter can compare against a user. A lookup (reference) or
// an Id/text field holds a Salesforce User Id; a picklist or multi-select
// picklist usually holds people's names, so those also match the user's name.
export const SF_SE_FILTER_FIELD_TYPES = ['reference', 'id', 'string', 'picklist', 'multipicklist'] as const

export const SF_FIELD_API_RX = /^[A-Za-z][A-Za-z0-9_]{0,79}$/
