# HubSpot production smoke checklist

Run this the first time ImpactIQ is pointed at a production HubSpot portal, and again after any release that touches
`services/hubspot/` or `services/crm/`. The developer test portal (247756533) has no Leads, no Marketing Hub and no
Project pipeline, so several of these paths have only been built from HubSpot's docs. This list is where they get their
first real check.

Do it with one admin account and one contributor account that is matched to a HubSpot owner. Use a test Deal and Company
that nobody else is working, and delete anything you created at the end.

Record each line as Pass, Fail (with what you saw) or N/A (feature not on this portal).

## 0. Before you start

- [ ] Admin → Integrations → HubSpot: the service key / private app token is saved, and **Check access** shows every
      required capability as ok. Note which optional ones (Leads, Campaigns, Projects, Tickets) are missing. Missing
      optional ones should be hidden in the app, not broken.
- [ ] Admin → Integrations → CRM is set to HubSpot and the lock note is shown once activities link HubSpot records.
- [ ] Admin → Scheduling: the HubSpot jobs (`hubspot_writeback_worker`, `hubspot_notes_push_worker`,
      `refresh_hubspot_snapshots`, `refresh_hubspot_opp_coverage`, `hubspot_detect_disconnected_links`, owner sync) are
      enabled, and none of the Salesforce jobs write `job_runs` rows.
- [ ] User Management: the contributor shows a linked HubSpot owner (matched by email, or set by hand). My Settings → My
      Connections shows the same owner for them.

## 1. Search each object

From the activity drawer, as the contributor:

- [ ] **Deals**: "my" search finds a Deal the contributor owns; Open Search finds one they don't. Closed Deals are hidden
      unless asked for.
- [ ] **Companies**: search by name finds the test Company. The hover preview opens and shows live fields.
- [ ] **Contacts**: the Who picker finds a Contact by name and by email.
- [ ] **Leads** (if the portal has them): the Leads tab finds a Lead. With Leads switched off in Admin → Integrations →
      CRM features, the tab is gone.
- [ ] **Campaigns** (Marketing Hub only): a Campaign can be found and linked. Without Marketing Hub the option is hidden.
- [ ] **Projects** (if a Project object is configured as the Projects source): the Project picker finds a Project on the
      linked Deal.
- [ ] **Tickets** (if an Activity Type has a Ticket picker extra): the picker finds a Ticket.

## 2. Meeting write-back

- [ ] **New meeting**: approve an activity linked to the test Deal, with no matching meeting already in HubSpot. Within a
      minute it shows Synced. In HubSpot, one meeting exists on the Deal with the right title, time, owner and mapped
      fields (type, notes).
- [ ] **Edit**: change the title in ImpactIQ. The same HubSpot meeting updates; no second meeting appears.
- [ ] **Adopted meeting** (v1.410): with the contributor's calendar connected to HubSpot, let HubSpot log a meeting
      itself, then approve the same meeting in ImpactIQ. It shows Synced, no duplicate appears on the Deal, and the
      HubSpot meeting gains only ImpactIQ's own fields. Its title and the organizer's notes are untouched.
- [ ] **Delete**: delete an adopted activity in ImpactIQ. The HubSpot meeting stays (adopted meetings are never deleted).
      Delete a created one: its meeting goes.
- [ ] **Create meetings switch off** (`hubspotCreateMeetings` in CRM features): an activity with no matching HubSpot
      meeting is not created in HubSpot. It shows Failed with "No matching meeting in HubSpot yet" and is checked again
      on the retry schedule.
- [ ] **Failure**: link an activity to a Deal you then delete in HubSpot, and approve it. It shows Failed with a readable
      error, appears in Admin → CRM Sync → Issues, and Retry works once the link is fixed.

## 3. Notes

- [ ] Add a note to a synced activity in the drawer and push it. It appears on the HubSpot record once, and CRM Sync →
      History shows the write with its source.

## 4. Tickets

- [ ] Attach a Ticket from the Ticket picker. The drawer shows its number, subject and status. Reopening the drawer
      refreshes them in the background. Nothing about the Ticket is written back to HubSpot.

## 5. Snapshots and dashboards

- [ ] Leader dashboards → **Refresh Sales Stage / Forecast from HubSpot**: it runs on the shared admin connection, reports success, and Deal stage,
      forecast category and amount on linked activities match HubSpot afterwards. A second click within 30 minutes is
      throttled.
- [ ] Attach Rate and Sales Team Breakdown load with HubSpot owners in place of Salesforce users.

## 6. Projects (POC | POV)

- [ ] With a HubSpot Project object as the source: link a Project to an activity, see it on Project-Specific Costing.
- [ ] With CriteriaIQ as primary or secondary: the CriteriaIQ panel finds Projects for the linked Deal by id (v1.409),
      with the name match as fallback.

## 7. Link health

- [ ] Delete (or merge) the test Company in HubSpot, then run `hubspot_detect_disconnected_links` from Admin →
      Scheduling → Run now. Activities on a deleted record are flagged on Activities Disconnected from HubSpot. Activities on
      a merged record move to the surviving record instead.
- [ ] Temporarily break the token. A run that fails flips no flags (a failed fetch never counts as deleted).

## 8. Historical import

- [ ] Admin → Integrations → CRM Historical Import: run a **dry run** over a recent month. Owner and type match rates look
      sensible, and unmapped HubSpot types are listed.
- [ ] Run a real import over one month. History dashboard rows are meetings on a Deal, Company or Project only, never
      calls, emails or tasks (see `docs/crm-providers.md`, "Historical import scope"). Meetings ImpactIQ wrote itself are
      skipped.
- [ ] Add an exclusion for an integration source (`source:<id>`) and confirm its meetings drop out after Relink.

## 9. MCP tools

With an MCP API key for the contributor (Admin → Integrations → MCP Server):

- [ ] `crm.search_opportunities` returns the contributor's open Deals.
- [ ] `crm.search_accounts` finds the test Company.
- [ ] `crm.get_record` returns the Deal's preview, and refuses a Salesforce-shaped id.

## 10. Clean up

- [ ] Delete the test activities in ImpactIQ and any meetings, notes or records left in HubSpot.
- [ ] Note the date, portal and release on the run, and file each Fail as an issue.
