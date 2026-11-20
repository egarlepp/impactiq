# Outlook calendar write-back

By default ImpactIQ only **reads** a user's Outlook calendar. From v1.156.0 a
user can optionally have ImpactIQ **write** an event to their own Outlook
calendar when they log an activity.

## What it does

- When a user submits an activity that is **not** already linked to an existing
  Outlook meeting, ImpactIQ creates a matching event on **their own** calendar
  (subject = activity title, body = notes, start/end = activity time,
  category `ImpactIQ`).
- Editing the activity later updates the same event (no duplicates).
- Activities created *from* an existing meeting are never written back, so real
  meetings are not duplicated.
- It is **per-user opt-in**, off by default.
- The event body carries the Event description, meeting owner, and **external**
  attendees. **Internal** attendees (see below) are set as real Required
  attendees — Microsoft Graph sends them an Outlook invite (there is no way to
  suppress this for `POST /me/events`), so external/customer attendees are
  deliberately kept out of the invite.

## Internal email domains

Admin → Integrations → Microsoft has an **Internal email domains** field
(comma-separated, e.g. `example.com`). An attendee whose email domain is on
this list is treated as internal and added as a real Required attendee (and
invited); everyone else is added to the event description only. Leave the field
blank to fall back to each user's own login-email domain. The Log Activity
drawer shows the effective domain(s) before submit.

## Admin setup (one-time)

The shared Azure app registration needs the **delegated** Microsoft Graph
permission `Calendars.ReadWrite` (it supersedes `Calendars.Read`, so calendar
reading keeps working):

1. Microsoft Entra ID → App registrations → your ImpactIQ app.
2. API permissions → Add a permission → Microsoft Graph → **Delegated
   permissions** → `Calendars.ReadWrite`.
3. Grant admin consent.

Because the granted scope changed, **already-connected users must reconnect
Outlook** (Settings → Connections → Outlook → Reconnect) before write-back can
work — until they do, a write attempt fails with a "reconnect needed" message.

## User opt-in

Settings → Connections → **"Write my logged activities to my Outlook
calendar."** The toggle is disabled until Outlook is connected, and shows a
notice explaining that events will be created on the user's calendar.

## Operations

- Writes are asynchronous, mirroring the Salesforce write-back queue: on submit
  the activity is flagged `outlook_sync_status = 'pending'` and a background
  worker (`outlook_writeback_worker`) creates/updates the event, then flips the
  status to `synced` / `failed`.
- The worker is visible on **Admin → Monitoring → Scheduling**.
- Activity cards show an **On Outlook** badge when synced, or a failure badge
  (hover for the reason) otherwise.
