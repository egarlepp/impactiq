// Short static changelog surfaced by the version chip popover in the nav.
// IMPORTANT: Update alongside every release commit that bumps APP_VERSION.
// The version popover only reads this file — if it isn't updated, users see
// stale release notes on the current version chip.
// v1.445.0: each bullet names its category (security | feature | improvement |
// fix, see changelogCategories.ts); What's new groups the bullets under those
// headings. Entries before v1.445.0 were categorized after the fact.
import type { ChangelogItem } from './changelogCategories.js'

export interface ChangelogEntry {
  version: string
  date: string                 // yyyy-MM-dd
  highlights: ChangelogItem[]  // 1–4 short bullets, each with its category
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.480.0',
    date: '2026-11-20',
    highlights: [
      { category: 'improvement', text: 'Reminders on the Activities page now show as one stacked card instead of a list: a count with arrows on the left moves through them, and marking one read or snoozing it brings up the next.' },
    ],
  },
  {
    version: '1.479.1',
    date: '2026-11-20',
    highlights: [
      { category: 'fix', text: 'The Docker image starts again. Since the November 16 dependency update it stopped at boot because a package the AI Assistant needs was left out of the image.' },
      { category: 'fix', text: 'A fresh Docker Compose install starts its bundled Postgres 18: the database volume now mounts where Postgres 18 expects it.' },
      { category: 'improvement', text: 'CI now builds the image and runs a fresh Docker Compose install on every pull request, so an install that cannot start is caught before merge.' },
    ],
  },
  {
    version: '1.479.0',
    date: '2026-11-17',
    highlights: [
      { category: 'feature', text: 'The effort API can now list the activities behind a CriteriaIQ project\'s count (type with its icon and color, who logged it, hours, start and end), so CriteriaIQ can show them in a drawer.' },
    ],
  },
  {
    version: '1.478.0',
    date: '2026-11-16',
    highlights: [
      { category: 'security', text: 'Every pull request and push now gets a CodeQL security scan, and CI uses GitHub Actions pinned to exact commits.' },
      { category: 'improvement', text: 'The README covers running behind a reverse proxy with HTTPS, backups (including keeping TOKEN_ENCRYPTION_KEY safe) and upgrades.' },
      { category: 'improvement', text: 'Added a code of conduct and a third-party notices file, and CI now tests migrations on the same Postgres 18 that Docker Compose runs.' },
    ],
  },
  {
    version: '1.477.1',
    date: '2026-11-16',
    highlights: [
      { category: 'improvement', text: 'Updated the translation libraries (i18next 27, react-i18next 18). Nothing changes on screen.' },
    ],
  },
  {
    version: '1.477.0',
    date: '2026-11-16',
    highlights: [
      { category: 'security', text: 'Requests to addresses an admin configures (webhooks, Okta, Salesforce sign-in, CriteriaIQ, AI webhooks) now re-check the address at the moment of connecting and never follow redirects, so a changed DNS answer or a redirect can\'t reach an internal address.' },
      { category: 'security', text: 'Addresses written as IPv4-mapped IPv6 (such as [::ffff:127.0.0.1]) and carrier-grade NAT addresses are now treated as internal.' },
      { category: 'security', text: 'The setup wizard\'s Salesforce test and the Salesforce identity lookup only contact salesforce.com or force.com hosts.' },
    ],
  },
  {
    version: '1.476.0',
    date: '2026-11-16',
    highlights: [
      { category: 'security', text: 'In production the server refuses to start while SESSION_SECRET or TOKEN_ENCRYPTION_KEY still holds the "change-me" placeholder from .env.example.' },
      { category: 'security', text: 'Docker Compose now requires a POSTGRES_PASSWORD of your own and publishes Postgres on 127.0.0.1 only, not on every network interface.' },
      { category: 'improvement', text: 'The repository has a security policy (private vulnerability reporting), contributing guide, issue and pull request templates, and Dependabot updates.' },
    ],
  },
  {
    version: '1.475.0',
    date: '2026-11-14',
    highlights: [
      { category: 'fix', text: 'An install started with its database already configured (for example with Docker Compose) can now create its first admin: the sign-in page shows "Create the first admin" until an account exists, using the setup token printed to the server log.' },
      { category: 'improvement', text: 'The first admin, from either the setup wizard or the new first-admin form, is the install\'s default admin, so App Updates can be set up.' },
      { category: 'improvement', text: 'How to Use ImpactIQ\'s overview now reads the same in every language.' },
    ],
  },
  {
    version: '1.474.0',
    date: '2026-11-14',
    highlights: [
      { category: 'feature', text: 'Salesforce: choose which Opportunity fields put a deal in someone\'s default Opportunity search. Map them as "SE Filter (Opportunity search)" in CRM Field Mappings; with none mapped, the search shows the Opportunities a person owns.' },
      { category: 'improvement', text: 'CRM Field Mappings suggests creating an Assigned SE lookup field in Salesforce when no SE Filter field is mapped yet.' },
      { category: 'improvement', text: 'The Assigned SE picker on Salesforce uses only the field mapped as Assigned SE — Write Target and is hidden until one is mapped. Existing Salesforce installs keep their current fields, now shown as mappings.' },
      { category: 'improvement', text: 'Attach Rate\'s Primary tier uses the field a team maps as its Assigned SE.' },
    ],
  },
  {
    version: '1.473.1',
    date: '2026-11-14',
    highlights: [
      { category: 'improvement', text: 'ImpactIQ is now licensed under Apache-2.0 (LICENSE and NOTICE files added).' },
      { category: 'improvement', text: 'New installs no longer pre-fill the Historical Import exclusion list with another organization\'s Salesforce users; add your own automation users from CRM Historical Import.' },
      { category: 'improvement', text: 'Removed the name of the organization ImpactIQ was first built at from code comments, docs and seed data, with a CI check that keeps it out.' },
    ],
  },
  {
    version: '1.473.0',
    date: '2026-11-03',
    highlights: [
      { category: 'feature', text: 'Demo Data now creates AI Note Settings Profiles: a starred Default profile and one profile per sample AI Assessment, including one set to Replace the default.' },
      { category: 'improvement', text: 'Demo AI Notes show the profiles\' custom sections (Pain and impact, Decision path, Objections raised, Success criteria status).' },
      { category: 'improvement', text: 'Activity cards no longer show a separate "Gong call" badge; the Transcripts icon already shows the linked calls and their count.' },
      { category: 'improvement', text: 'Activity type suggestions now send all of a person\'s unmatched meetings in one AI request instead of one per meeting, and AI Assistant → Usage shows how many items each request covered.' },
    ],
  },
  {
    version: '1.472.1',
    date: '2026-11-03',
    highlights: [
      { category: 'improvement', text: 'The User Management and Team Management edit forms now use the full width of the page instead of stopping partway across.' },
    ],
  },
  {
    version: '1.472.0',
    date: '2026-11-03',
    highlights: [
      { category: 'improvement', text: 'User Management and Team Management edit forms are grouped into colored sections with icons. Open or close each one, or use Expand all / Collapse all; a closed section shows a one-line summary of its values.' },
      { category: 'improvement', text: 'Required fields carry a red *, and the save bar names any that are still empty. Only names, email and team name are required, plus a password on a new user when the sign-in method allows one.' },
      { category: 'improvement', text: 'A user\'s role on the current team can be changed inside the edit form, the hourly cost note links to Cost Groups, and the team form no longer shows the Work Week Defaults heading twice.' },
    ],
  },
  {
    version: '1.471.1',
    date: '2026-11-03',
    highlights: [
      { category: 'fix', text: 'Outlook\'s timezone names (like "Pacific Standard Time") are now converted to standard ones, so digests, weekly recaps and nudges go out at your local time instead of UTC, and times on screen no longer fail to show.' },
      { category: 'fix', text: 'Timezones already saved from Outlook are converted when the app starts.' },
    ],
  },
  {
    version: '1.471.0',
    date: '2026-11-03',
    highlights: [
      { category: 'feature', text: 'AI Assessments → Settings Profiles: star one profile as the team\'s Default. People who haven\'t picked their own AI Note sections get its sections, custom sections included.' },
      { category: 'feature', text: 'Each profile is set to Add to default or Replace default. Where its assessment runs, a Replace profile is used instead of the Default profile; a person\'s own sections are always kept.' },
      { category: 'improvement', text: 'Each team\'s Default sections moved into a Default profile, and the separate Default sections editor on the AI Notes settings is gone.' },
      { category: 'improvement', text: 'AI Assistant → AI features: each feature says what it does, where it shows up and what happens when it\'s off. My Notes hides AI Organize and Ask My Notes when those features are off.' },
    ],
  },
  {
    version: '1.470.0',
    date: '2026-11-03',
    highlights: [
      { category: 'fix', text: 'User Management → Edit user: the Subteams picker lists only subteams of the teams that user is part of, not every team\'s.' },
      { category: 'improvement', text: 'A subteam left over from a team the user is no longer on shows in an amber group so you can remove it, and removing someone from a team now also takes them off its subteams.' },
    ],
  },
  {
    version: '1.469.0',
    date: '2026-11-03',
    highlights: [
      { category: 'feature', text: 'My Settings → Timezone: set your timezone by hand from the list, even without Outlook or a CRM connected. It starts on UTC.' },
      { category: 'fix', text: 'A timezone you pick (by hand or your CRM\'s) now stays: the hourly Outlook check no longer switches it back. Connecting Outlook still switches to Outlook, and you can override it again.' },
      { category: 'improvement', text: 'The Timezone section names your CRM (Salesforce or HubSpot, using the HubSpot portal\'s timezone) and hides the CRM row when no CRM is chosen.' },
    ],
  },
  {
    version: '1.468.0',
    date: '2026-11-03',
    highlights: [
      { category: 'feature', text: 'AI Assistant → AI features: turn any single AI feature off. Turning off Activity type suggestions types meetings by keyword rules and the team default only, with no AI requests.' },
      { category: 'fix', text: 'Activity type suggestions made while loading the weekly calendar now show the person whose calendar it was in Usage, instead of No team and Automatic (no person).' },
    ],
  },
  {
    version: '1.467.1',
    date: '2026-11-03',
    highlights: [
      { category: 'fix', text: 'Keyword Rules: adding another team to a rule\'s scope now replaces that team\'s own matching rule instead of leaving both. A rule is only replaced when the one you saved covers all its keywords.' },
      { category: 'fix', text: 'A keyword rule shared to another team shows its activity type by name there, and matches meetings there, instead of showing an id and never matching.' },
      { category: 'fix', text: 'Deleting a team no longer deletes keyword rules it shared with other teams.' },
    ],
  },
  {
    version: '1.467.0',
    date: '2026-11-02',
    highlights: [
      { category: 'improvement', text: 'AI Assistant → Usage this month: see the month\'s AI use by Feature, Team or Person, with requests, failures, tokens, cost and each one\'s share of the cost. Click a row to see only its requests.' },
      { category: 'improvement', text: 'Every request this month is listed with its team and person, 20 per page, and can be filtered by feature, team and person.' },
    ],
  },
  {
    version: '1.466.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'AI Assessments → Settings: Settings Profiles. A profile is a named set of AI Note sections, built-in ones plus your own custom sections, each with instructions for the AI, an icon and a color.' },
      { category: 'feature', text: 'Pick a Settings Profile on an assessment, and wherever that assessment runs, its sections are added to the owner\'s own AI Note sections. Several assessments on one activity combine their profiles.' },
      { category: 'improvement', text: 'The AI Notes tab shows custom sections with their own icon and color, and says which profiles added sections.' },
    ],
  },
  {
    version: '1.465.0',
    date: '2026-11-02',
    highlights: [
      { category: 'improvement', text: 'AI Assessments page: assessments are collapsible cards with their own icon and icon color, criteria open one at a time and reorder by dragging or with the arrows, and score levels stay folded until you need them.' },
      { category: 'improvement', text: 'AI Assessments → Assignments: one compact row per Activity Type, tinted with its color, with Subtypes folded underneath in a lighter tint.' },
      { category: 'improvement', text: 'Cards on the AI Assessments page now have a solid background in light and dark mode, and Feature routing on the AI Assistant page shows each feature\'s icon.' },
    ],
  },
  {
    version: '1.464.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'AI Provider form: a Fetch latest models button lists the models your key can use (or the current models from the LiteLLM price list) and fills the input and output price per million tokens. Type your own prices if you have negotiated ones; yours are saved.' },
      { category: 'improvement', text: 'AI Assistant page: provider logos beside each provider and in Recent requests, header icons on every card, current model suggestions for every provider, and the feature routing card now explains that a second active provider unlocks per-feature routing.' },
      { category: 'feature', text: 'AI Assessments travel with Activity Types Export / Import: the file carries each assessment, its criteria and which types and Subtypes it runs on, previewed before anything changes.' },
      { category: 'improvement', text: 'Demo Data now includes three sample AI Assessments with scores, so the Assessments tab and the AI Assessment Scores dashboard have something to show.' },
    ],
  },
  {
    version: '1.463.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'New AI Assessment Scores dashboard (Health group) for Leaders: per assessment, the team\'s average score with not-observed criteria counted as zero, the average over observed criteria only, and how many criteria went unobserved per activity.' },
      { category: 'feature', text: 'The dashboard breaks scores down by person and by criterion (average 1–5 level and how often each was observed), and lists the scored activities with a link to open each one.' },
      { category: 'security', text: 'Same rule as the Assessments tab: a Leader never sees scores on their own activities, and the dashboard needs both its own Role Management row (Leaders and Team Admins on by default) and the Assessments tab grant.' },
    ],
  },
  {
    version: '1.462.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'AI Assessments now score activities. When AI Notes are generated from a Gong transcript, every assessment assigned to the activity\'s type or Subtype is scored too, with a 1–5 level, a reason and call timestamps for each criterion.' },
      { category: 'feature', text: 'New Assessments tab on the activity drawer, for Leaders only (never the activity\'s owner). It shows two scores per assessment: one with criteria not observed on the call counted as zero, and one over observed criteria only, with the not-observed count beside it.' },
      { category: 'feature', text: 'Leaders can click Run assessment on any activity they can see that has a Gong transcript, to score it or score it again.' },
      { category: 'improvement', text: 'AI Assessments can use their own AI provider on Admin → AI Assistant, and Role Management has a new Assessments tab row (Leaders and Team Admins on by default).' },
    ],
  },
  {
    version: '1.461.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'New Admin → Activities & Rules → AI Assessments page. Define scored assessments: criteria with a weight and a 1–5 scale with a description per level. Share them with other teams you manage, and App Admins can lock one so teams use it as is.' },
      { category: 'feature', text: 'Assign up to 3 assessments to each Activity Type, or to one Subtype. A Subtype without its own row uses its type\'s assessments.' },
      { category: 'improvement', text: 'AI Notes settings moved from Workplace to the Settings tab of AI Assessments. Old links still open them.' },
      { category: 'improvement', text: 'AI Notes sections each have their own color and can be collapsed, with item and to-review counts on every section header, plus Expand all / Collapse all.' },
    ],
  },
  {
    version: '1.460.1',
    date: '2026-11-02',
    highlights: [
      { category: 'fix', text: 'Removed a stray up/down scrollbar that showed at the right end of the activity drawer\'s tab row on Windows.' },
    ],
  },
  {
    version: '1.460.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'Activity cards show a Transcripts icon right of the Notes icon: gray when no Gong call is linked, blue with a count when one is. Click it to open the activity on its Transcripts tab.' },
      { category: 'improvement', text: 'The activity drawer is wider, so Edit, Notes, Sync History, Transcripts and AI Notes fit on one line. On a phone the tabs scroll sideways and the open tab stays in view.' },
    ],
  },
  {
    version: '1.459.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'Demo Data now includes sample Gong calls on recent customer meetings: linked calls with transcripts on the Transcripts tab, plus a few unlinked calls shown as suggestions. No Gong connection needed.' },
      { category: 'feature', text: 'Demo AI Notes on many of those calls, some waiting for review, some partly reviewed and some fully reviewed, so the AI Notes tab and My Notes → AI show real examples. Generate is off for demo activities, so no AI is used.' },
    ],
  },
  {
    version: '1.458.0',
    date: '2026-11-02',
    highlights: [
      { category: 'feature', text: 'My Notes: a Written / AI switch. The AI side lists the AI Notes on your activities, grouped by Opportunity / Account like your notes, with search, sort, Organize by Account and how many items wait for review.' },
      { category: 'feature', text: 'Review AI Notes right from My Notes: Keep, Remove, Keep all, Regenerate and Copy to Notes work the same as on the activity\'s AI Notes tab, and a filter shows only AI Notes with items to review.' },
    ],
  },
  {
    version: '1.457.0',
    date: '2026-11-01',
    highlights: [
      { category: 'feature', text: 'AI Notes tab on activities: Generate reads the linked Gong transcript (if any) and your own notes, and writes a summary, a check of the call against your notes, next steps, risks and MEDDPICC evidence, each item citing a call moment or note. Keep, Remove, Keep all, Regenerate (kept items stay) and Copy to Notes.' },
      { category: 'feature', text: 'Admin → Workplace → AI Notes: per-team on/off switch (off by default), default sections, and a monthly spend limit set by an App Admin inside the app-wide AI budget. My Settings → AI Notes picks your own sections.' },
      { category: 'security', text: 'An AI Note follows its transcript\'s rules (owner, people on the call, App Admins, leaders only with the team switch). One written from a private note is visible to its owner and App Admins only, and only the owner\'s own notes are ever read.' },
    ],
  },
  {
    version: '1.456.2',
    date: '2026-11-01',
    highlights: [
      { category: 'fix', text: 'Activities: when weeks start on Sunday, activities on the first Sunday of the week now show in the list, and the weekly capacity bar and charts count Sunday to Saturday, the same days the page shows.' },
      { category: 'fix', text: 'Activities logged late on Sunday evening could drop out of the week for people west of UTC. The week now ends at midnight in your own time zone.' },
    ],
  },
  {
    version: '1.456.1',
    date: '2026-11-01',
    highlights: [
      { category: 'fix', text: 'Activities: on a Sunday, clicking a day on the month calendar opened the week before it (click the 19th, get the week of the 11th), and "this week" showed last week. A Sunday now opens the week that starts on it.' },
    ],
  },
  {
    version: '1.456.0',
    date: '2026-11-01',
    highlights: [
      { category: 'feature', text: 'Gong calls now link to their activity on their own: every 15 minutes, when the call was recorded from the same calendar meeting, or when exactly one call the owner was on is a strong match. Unlinking a call keeps it off that activity for good. Can be turned off on the Gong card.' },
      { category: 'feature', text: 'Optional Gong webhook: new calls arrive in seconds. The Gong card shows the URL to paste into a Gong "Fire webhook" rule and takes the public key Gong shows; each delivery\'s signature is checked and the call is re-read from Gong.' },
      { category: 'improvement', text: 'Weekly view: "Recorded in Gong" on suggested meetings Gong recorded, and a "Gong call" badge on activities with a linked call.' },
      { category: 'fix', text: 'The Transcripts tab could not load suggestions, search or link calls because of a database query error. Fixed.' },
    ],
  },
  {
    version: '1.455.1',
    date: '2026-11-01',
    highlights: [
      { category: 'security', text: 'Updated two file-matching libraries used by error tracking (glob and minimatch) to close two moderate security advisories.' },
    ],
  },
  {
    version: '1.455.0',
    date: '2026-11-01',
    highlights: [
      { category: 'feature', text: 'Transcripts tab on the activity drawer: link a Gong call to an activity and read its transcript, with timestamps that open the recording in Gong. Shown only when Gong is connected.' },
      { category: 'feature', text: 'With no call linked, the tab suggests likely Gong calls (same meeting, start time, people on the call, same CRM record, title) and offers a search by title and date.' },
      { category: 'security', text: 'Transcripts are readable by the activity owner, people on the call and App Admins. Leaders and Team Admins only when an App Admin turns on "Leaders can read transcripts" for the team. New Role Management key: Activity Transcripts (Gong).' },
      { category: 'improvement', text: 'Gong card: run the call index by hand, the per-team leader switch, and manual links for people whose Gong email differs. Transcripts are cached for the period set on the card, then removed.' },
    ],
  },
  {
    version: '1.454.0',
    date: '2026-11-01',
    highlights: [
      { category: 'feature', text: 'Project activity counts for CriteriaIQ: one call answers how many activities of the chosen types are linked to each of up to 200 CriteriaIQ projects, so its project table can show an Activities column.' },
      { category: 'feature', text: 'CriteriaIQ can list your activity type names (and which ones have a Project picker) so its admin can choose which types count toward a project.' },
      { category: 'improvement', text: 'Faster Salesforce id matching on activities linked to an Opportunity or a Project, for the effort API and the new counts.' },
      { category: 'security', text: 'Counts only, through the same effort:read key: no titles, notes, people or cost. A batch counts against the key\'s rate limit as one call per 50 projects.' },
    ],
  },
  {
    version: '1.453.0',
    date: '2026-11-01',
    highlights: [
      { category: 'improvement', text: 'How to Use ImpactIQ has a new Connecting CriteriaIQ section: every step, in both apps, to read CriteriaIQ projects, turn on live refresh and show SE effort in CriteriaIQ, plus what to check when it doesn\'t work.' },
      { category: 'fix', text: 'The CriteriaIQ connection card now names the right places in CriteriaIQ for the API key and the webhook, and links to the setup guide.' },
    ],
  },
  {
    version: '1.452.0',
    date: '2026-10-31',
    highlights: [
      { category: 'feature', text: 'Gong connection: App Admins can connect Gong under Admin → Integrations → Gong, with an access key (the default) or a Gong OAuth app. First step toward call transcripts on activities.' },
      { category: 'feature', text: 'Check access shows which Gong permissions the key has, and a daily Gong user sync matches ImpactIQ people to Gong users by email (new Transcripts group on Scheduling).' },
      { category: 'improvement', text: 'App Health\'s Integrations tile includes Gong once it is connected, and the transcript cache period (30 days by default, up to 1 year) is set on the same card.' },
      { category: 'security', text: 'Gong keys and tokens are stored encrypted, calls only ever go to a Gong API host, and the OAuth connect is bound to the admin who started it.' },
    ],
  },
  {
    version: '1.451.0',
    date: '2026-10-31',
    highlights: [
      { category: 'improvement', text: 'Admin → Demo Data: a large Demo Mode banner, and the demo leader\'s sign-in stays on the page so you can sign in any time. The app reloads into the demo team after Generate.' },
      { category: 'feature', text: 'Demo data now takes a timezone, a calendar mix (approved, declined and out-of-office shares) and PTO days, and Reseed rebuilds it with those settings.' },
      { category: 'fix', text: 'Scheduling and My Notes show demo data: the admin\'s and demo people\'s calendars appear on the grid, and demo activities carry notes.' },
      { category: 'improvement', text: 'Most demo activities now carry a Subtype, and an Activity names field lets you add your team\'s own names to meeting subjects and activity titles.' },
    ],
  },
  {
    version: '1.450.0',
    date: '2026-10-29',
    highlights: [
      { category: 'feature', text: 'CriteriaIQ live refresh: when a CriteriaIQ project changes, its details in ImpactIQ update within seconds instead of after a few minutes or overnight. Turn it on under Admin → Integrations → CriteriaIQ connection.' },
      { category: 'security', text: 'Live refresh accepts only webhooks signed with a secret ImpactIQ makes, with the time inside the signature, and refuses old or repeated ones on every server.' },
    ],
  },
  {
    version: '1.449.0',
    date: '2026-10-27',
    highlights: [
      { category: 'feature', text: 'The effort API now gives one cost total for the Opportunity (labor plus direct costs, in USD), so CriteriaIQ can show cost next to hours.' },
      { category: 'feature', text: 'A link with ?openOpportunity= opens the activities drawer for that Opportunity, so CriteriaIQ\'s SE Effort card can link straight to the activities behind its hours.' },
      { category: 'security', text: 'Cost is never given per person or per activity type, since that would reveal a person\'s cost rate.' },
    ],
  },
  {
    version: '1.448.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'New effort:read API key type: CriteriaIQ can read hour totals per CRM Opportunity (by person and activity type) to show SE effort on a project.' },
      { category: 'security', text: 'An effort:read key reaches only that one read-only endpoint, returns totals with no titles or notes, needs a Team Leader or admin owner and covers only the owner\'s teams.' },
    ],
  },
  {
    version: '1.447.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'CriteriaIQ projects are read through CriteriaIQ\'s new summary API, with a fallback for older CriteriaIQ versions.' },
      { category: 'feature', text: 'The CriteriaIQ panel on an activity shows MAP task progress next to success criteria.' },
      { category: 'fix', text: 'CriteriaIQ success criteria marked complete now count as met (they showed 0 met before).' },
    ],
  },
  {
    version: '1.446.1',
    date: '2026-10-26',
    highlights: [
      { category: 'fix', text: 'Collapsed sidebar: icons for pages you visited earlier no longer keep a highlighted background. Only the current page is highlighted.' },
    ],
  },
  {
    version: '1.446.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'Admin → Workplace → Terminology: choose what your organization calls an evaluation (Eval, POC, POV, POx, Project or your own word). New installs use POx, so the evaluation Activity Type is "POx Work".' },
      { category: 'improvement', text: 'The term names the evaluation Activity Type on new teams, the default Guide Distinctions and nudge rule, and the Won w/o dashboard, approval check and help wording.' },
      { category: 'feature', text: 'Changing the term can rename the existing "Eval Work" Activity Types in one step, with nudge rules and Guide Distinctions following and the same Type value still sent to the CRM.' },
    ],
  },
  {
    version: '1.445.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'What\'s new groups each release under Security & Compliance, New Features, Improvements and Fixes, each with its own color, the same headings CriteriaIQ uses.' },
      { category: 'improvement', text: 'Every earlier release note has been sorted into those four groups too.' },
      { category: 'fix', text: 'The App Updates panel showed curly quotes and dashes in some older release notes as codes like u2019; it shows the real characters now.' },
    ],
  },
  {
    version: '1.444.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'App Health: Integrations shows when each service last answered or failed, how many people need to reconnect, and who has a calendar that stopped syncing.' },
      { category: 'feature', text: 'App Health: the Database tile adds cache hit ratio, tables with many dead rows and the last vacuum; a new Data & Backups tile checks log cleanup and reminds you to take a backup.' },
      { category: 'improvement', text: 'App Health: a Readiness check panel explains what to point at /ready (load balancers, uptime monitors) and shows when it was last called.' },
      { category: 'improvement', text: 'Backup & Restore shows the last backup and lets you choose when App Health reminds you (or turn it off).' },
    ],
  },
  {
    version: '1.443.0',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'Scheduling: Clear on Recent runs now deletes every job run (after a confirm), so the cards and each job\'s Last run start over.' },
      { category: 'fix', text: 'Background jobs wait for database updates to finish after a restart, so a cleanup run can no longer fail on a table that is still being created.' },
      { category: 'fix', text: 'The retention cleanup job trims each log table on its own: one failure no longer skips the rest, and the error names the table.' },
    ],
  },
  {
    version: '1.442.0',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'App Health: the System Health Overview tiles and the database cards now have solid backgrounds instead of see-through ones.' },
    ],
  },
  {
    version: '1.441.0',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'Scheduling: each category shows how many of its jobs are active (green) and inactive (red: turned off or not set up).' },
      { category: 'improvement', text: 'Recent runs pages through every run, 20 at a time by default, and has a Clear button that hides earlier runs from the list.' },
    ],
  },
  {
    version: '1.440.0',
    date: '2026-10-26',
    highlights: [
      { category: 'feature', text: 'App Health opens with a System Health Overview: Healthy, Warnings and Errors at a glance, refreshed automatically, with a tile each for the database, background jobs, queues, integrations, email, AI Assistant and the app server.' },
      { category: 'improvement', text: 'Background jobs that stop running on schedule, and write-back or webhook work that has waited too long, now show up there.' },
      { category: 'feature', text: 'ImpactIQ keeps a 30-day log of outgoing email, so a broken email setup shows on App Health.' },
      { category: 'feature', text: 'New /ready endpoint for load balancers and uptime monitors: it also checks the database.' },
    ],
  },
  {
    version: '1.439.0',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'Scheduling groups jobs by what they do (CRM write-back, data refresh, notifications and more), collapsed by default, with a job count per group and an expand/collapse all button.' },
      { category: 'improvement', text: 'A group whose name turns red has a job whose last run failed.' },
      { category: 'improvement', text: 'Recent runs can show the last 20, 50 or 100 runs, and lists each run\'s category.' },
    ],
  },
  {
    version: '1.438.0',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'Scheduled jobs wait until their integration is connected: HubSpot, Salesforce, Outlook, CriteriaIQ, App Updates, email or Slack, and event webhooks. Scheduling shows them as Not set up and says what they need.' },
      { category: 'fix', text: 'Refresh Historical Opps no longer logs an error each night when no historical import has run.' },
    ],
  },
  {
    version: '1.437.1',
    date: '2026-10-26',
    highlights: [
      { category: 'improvement', text: 'HubSpot owners only sync while HubSpot is the active CRM, including from the Sync owners button on the HubSpot card.' },
    ],
  },
  {
    version: '1.437.0',
    date: '2026-10-25',
    highlights: [
      { category: 'improvement', text: 'Scheduling lists and runs only the active CRM\'s jobs; with the CRM set to None, no CRM job runs.' },
      { category: 'feature', text: 'New nightly Salesforce user sync, matching the HubSpot owner sync, so Sales Team Alignment stays current on either CRM.' },
      { category: 'improvement', text: 'The Salesforce link-health job now shows on Scheduling, and job descriptions name their CRM.' },
    ],
  },
  {
    version: '1.436.0',
    date: '2026-10-24',
    highlights: [
      { category: 'feature', text: 'Communications rules can also send as a Slack DM: the daily digest, weekly recap and new sign-in alert go to the person, the job failure and AI budget alerts to App Admins only.' },
      { category: 'improvement', text: 'With Slack connected and no email set up, these messages still go out as Slack DMs.' },
      { category: 'improvement', text: 'Send Test also DMs you when the rule has Slack on.' },
    ],
  },
  {
    version: '1.435.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Demo Data now links some work to Leads and Campaigns, and converted Leads roll up into their Accounts.' },
      { category: 'improvement', text: 'The demo team has nudge history, snoozes and announcements (running, scheduled and ended).' },
      { category: 'improvement', text: 'On a HubSpot install, demo Deals use HubSpot stage and forecast names, and Projects use HubSpot Projects.' },
    ],
  },
  {
    version: '1.434.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Demo Data now fills the exception queues: drafts, failed CRM syncs, disconnected links, meetings deleted from Outlook, Why Meeting? reasons, support tickets and Non-Activity meetings.' },
      { category: 'improvement', text: 'The demo calendar includes private, cancelled, tentative, free and all-day meetings.' },
      { category: 'improvement', text: 'Generate can also create a demo Team Leader who signs in with a one-time password.' },
      { category: 'improvement', text: 'Demo activities are never sent to Salesforce or HubSpot, and Generate and Remove are now in the Audit Log.' },
    ],
  },
  {
    version: '1.433.0',
    date: '2026-10-24',
    highlights: [
      { category: 'feature', text: 'Nudge rules can also send as a Slack DM to each person, through the Slack bot in Admin → Integrations.' },
      { category: 'feature', text: 'Announcements can also go to Slack: a team-wide one posts to the team\'s Slack channel (or DMs everyone if there isn\'t one), a subteam or personal one DMs each person.' },
      { category: 'improvement', text: 'Nudges now go out on a schedule during each person\'s working hours, so Slack, email and webhooks no longer wait for them to open ImpactIQ.' },
      { category: 'improvement', text: 'My Settings has a Send me Slack DMs switch.' },
    ],
  },
  {
    version: '1.432.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Demo Data now fills the cost, Opportunity, Project, Attach Rate, Subteam, Subtype and History dashboards, with realistic weekly hours.' },
      { category: 'improvement', text: 'Most demo meetings are already logged, so the weekly view shows logged badges and Meeting Load has data.' },
      { category: 'improvement', text: 'The demo plants a few unusual changes so the What changed panel has something to show.' },
      { category: 'fix', text: 'Nightly Salesforce jobs skip demo record ids, and deleting a team no longer fails when it has Attach Rate fields.' },
    ],
  },
  {
    version: '1.431.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Event webhooks can be limited to specific people, alongside the team filter.' },
      { category: 'feature', text: 'New webhook events: suspicious sign-in, account disabled and AI budget reached, for security and cost alerts.' },
      { category: 'feature', text: 'New anomaly.found event: each team\'s "What changed" findings for the last completed week, sent once per week.' },
    ],
  },
  {
    version: '1.430.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Demo Data now goes into its own [Demo] Sales Engineering team, so it never mixes into a real team. Remove deletes that team.' },
      { category: 'improvement', text: 'The demo Outlook calendar only replaces the calendar for the demo contributors and the admin who generated it, not every user.' },
      { category: 'fix', text: 'Removing demo data no longer clears other people\'s nudge notifications, and the demo product names are now generic.' },
    ],
  },
  {
    version: '1.429.1',
    date: '2026-10-24',
    highlights: [
      { category: 'fix', text: 'Fix: Admin → Integrations → Event Webhooks loads again instead of showing an HTTP 500 error.' },
    ],
  },
  {
    version: '1.429.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations: once the CRM is locked, the other CRM\'s connection card shows it can\'t be used on this install instead of a setup form, and the CRM card says so too.' },
    ],
  },
  {
    version: '1.428.0',
    date: '2026-10-24',
    highlights: [
      { category: 'feature', text: 'New: Event Webhooks (Admin → Integrations). ImpactIQ can send a signed message to n8n, Power Automate, Zapier or your own service when an activity is submitted, a CRM sync fails, an approved meeting is deleted from Outlook, a nudge goes out or a background job fails.' },
      { category: 'improvement', text: 'Deliveries retry on their own for about a day, and a delivery log shows what was sent and how the receiver answered, with Send test and Retry buttons.' },
    ],
  },
  {
    version: '1.427.1',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'The sign-in page now says why an Okta or Microsoft sign-in was refused, for example a disabled account or no ImpactIQ account for that user.' },
    ],
  },
  {
    version: '1.427.0',
    date: '2026-10-24',
    highlights: [
      { category: 'improvement', text: 'Notifications: a Clear all button empties the list after you confirm. Reminders that are still due come back tomorrow.' },
      { category: 'improvement', text: 'Notifications: group the list by month or by category. The newest group opens, the rest collapse with an item count, and your choice is remembered.' },
    ],
  },
  {
    version: '1.426.0',
    date: '2026-10-23',
    highlights: [
      { category: 'feature', text: 'New AI provider: Webhook. ImpactIQ can send its AI requests to a URL you control, such as an n8n workflow, an AI gateway or a self-hosted model, so meeting and note text can stay on your own network.' },
      { category: 'security', text: 'Webhook requests are signed with a shared secret, and a webhook on your private network can be allowed explicitly.' },
    ],
  },
  {
    version: '1.425.1',
    date: '2026-10-23',
    highlights: [
      { category: 'fix', text: 'Fix: the language and notifications menus in the top bar open fully again instead of being cut off behind the page.' },
    ],
  },
  {
    version: '1.425.0',
    date: '2026-10-23',
    highlights: [
      { category: 'security', text: 'App Admins can now disable an account in User Management. A disabled user is signed out everywhere, their API keys stop working, and they can\'t sign in until re-enabled.' },
      { category: 'security', text: 'The first-run setup wizard now asks for a one-time token from the server log.' },
      { category: 'security', text: 'Security fixes: CriteriaIQ project links and record previews follow who can see the activity.' },
    ],
  },
  {
    version: '1.424.0',
    date: '2026-10-23',
    highlights: [
      { category: 'security', text: 'New Admin setting: how many proxies sit in front of ImpactIQ, so per-IP limits see the real address and can\'t be fooled by a forged header.' },
      { category: 'security', text: 'New HubSpot setting: choose who may edit a Deal from ImpactIQ, either anyone matched to a HubSpot user or only people named in Deal properties you pick.' },
      { category: 'security', text: 'Only people matched to a HubSpot user can use HubSpot from ImpactIQ, and notes post only to the records their activity is linked to.' },
    ],
  },
  {
    version: '1.423.0',
    date: '2026-10-23',
    highlights: [
      { category: 'security', text: 'Security fix: connecting Salesforce or Outlook now only completes in the browser that started it, signed in as the same person.' },
      { category: 'security', text: 'Old-style sign-in cookies are no longer accepted, so signing out everywhere always takes effect.' },
    ],
  },
  {
    version: '1.422.0',
    date: '2026-10-23',
    highlights: [
      { category: 'security', text: 'Security fixes: you can only read activities, notes and team settings for teams you can see, and other people\'s drafts stay private everywhere.' },
      { category: 'security', text: 'An activity can only use an activity type that belongs to its team.' },
    ],
  },
  {
    version: '1.421.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'Search now finds dashboards by name and opens the one you pick.' },
      { category: 'improvement', text: 'Search now looks inside the Guide (each activity type\'s guidance, Subtypes and Distinctions) and the text of How to Use ImpactIQ.' },
      { category: 'improvement', text: 'Search only shows dashboards, settings and help for pages your role can open.' },
    ],
  },
  {
    version: '1.420.0',
    date: '2026-10-23',
    highlights: [
      { category: 'feature', text: 'Search the whole app from the header (or Ctrl+K): pages, admin settings, help topics and your own activities.' },
      { category: 'improvement', text: 'The ? button opens help for the page you are on, and unknown links now show a "page not found" message.' },
      { category: 'improvement', text: 'The sidebar groups pages under headings, and Admin sections have their own links you can bookmark.' },
      { category: 'improvement', text: 'Printing a page leaves out the sidebar and header and prints the whole page in light mode.' },
    ],
  },
  {
    version: '1.419.0',
    date: '2026-10-23',
    highlights: [
      { category: 'feature', text: 'Activities works on a phone: the sidebar opens from a menu button, and a List / Calendar toggle switches between your activities and your calendar.' },
    ],
  },
  {
    version: '1.418.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'Pages load a little faster: the release notes behind the version number now load only when you open them.' },
    ],
  },
  {
    version: '1.417.0',
    date: '2026-10-23',
    highlights: [
      { category: 'security', text: 'Logging an activity now checks that you are on the chosen team. App Admins and users who can see all teams can still log on any team.' },
    ],
  },
  {
    version: '1.416.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'Behind the scenes: the four largest code files are split into smaller ones. Nothing changes in the app.' },
    ],
  },
  {
    version: '1.415.0',
    date: '2026-10-23',
    highlights: [
      { category: 'fix', text: 'User Management: a user can now be saved with the Azure-only sign-in method. The database used to reject it.' },
      { category: 'improvement', text: 'New automated tests cover logging and editing activities, password sign-in with MFA, and the Salesforce write-back.' },
      { category: 'improvement', text: 'HubSpot historical import stays meetings only, and there is a written smoke checklist for a first production HubSpot portal.' },
    ],
  },
  {
    version: '1.414.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'Background jobs run once even with two app servers: each run takes a database lock, and the other server skips that run.' },
      { category: 'improvement', text: 'Admin → Scheduling: Run Now on a job that is already running says so instead of starting a second copy.' },
      { category: 'feature', text: 'Optional error tracking: set SENTRY_DSN (Sentry or a self-hosted GlitchTip) to report server errors and failed jobs. Off by default.' },
      { category: 'security', text: 'The Docker image runs as a non-root user and has a health check.' },
    ],
  },
  {
    version: '1.413.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'The remaining CRM columns (tickets, field mappings, note pushes, historical import, calendar suggestions, CRM user links and more) and the enum types are renamed from sf_* to crm_*. No data changes.' },
      { category: 'improvement', text: 'CRM Field Mappings and Activity Types export files made before this version still import.' },
    ],
  },
  {
    version: '1.412.1',
    date: '2026-10-23',
    highlights: [
      { category: 'fix', text: 'Fresh installs migrate cleanly on a real Postgres: migrations now apply one file at a time, so the Setup wizard no longer fails on an empty database.' },
      { category: 'improvement', text: 'Every pull request now runs typechecks, tests, the translation check, a dependency audit and a full migration of an empty database.' },
    ],
  },
  {
    version: '1.412.0',
    date: '2026-10-23',
    highlights: [
      { category: 'improvement', text: 'Tables that hold data for any CRM are renamed from sf_* to crm_* (field mappings, CRM users and alignments, historical import, Attach Rate coverage, tickets, activity type extras). No data changes.' },
      { category: 'improvement', text: 'Salesforce-only tables keep their sf_* names.' },
    ],
  },
  {
    version: '1.411.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'The activity columns that hold CRM links, snapshots and sync state are renamed from sf_* to crm_* (database and code), since HubSpot fills them too. No data changes.' },
      { category: 'improvement', text: 'MCP: activities.list and activities.get now return crmWhatId, crmAccountName and the other crm* fields in place of the sf* names.' },
    ],
  },
  {
    version: '1.410.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'HubSpot: before creating a meeting, ImpactIQ looks for the same meeting already logged by HubSpot\'s own calendar sync (same owner, start and end time) and fills that one in instead, so a meeting no longer shows twice.' },
      { category: 'improvement', text: 'An adopted meeting keeps HubSpot\'s title, times and invite body; ImpactIQ adds the activity type, its notes as internal notes and the Deal/Company links, and never deletes it.' },
      { category: 'feature', text: 'New CRM features switch on HubSpot, Create HubSpot meetings: off means ImpactIQ only fills in meetings HubSpot already has, and checks again later when none has turned up yet.' },
    ],
  },
  {
    version: '1.409.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'CriteriaIQ Project suggestions now match the Opportunity or Deal by its CRM id, which CriteriaIQ stores on each project, instead of only by name.' },
      { category: 'improvement', text: 'The CriteriaIQ Project picker also lists other projects on the same Account or Company, and says when a suggestion was matched by name only.' },
      { category: 'improvement', text: 'Won w/o POC counts an Opportunity whose id a CriteriaIQ project holds, even after the Opportunity is renamed.' },
    ],
  },
  {
    version: '1.408.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'My Settings → My Connections follows the CRM: on HubSpot it shows which HubSpot owner you\'re matched to (there\'s nothing to sign in to), and with no CRM only Outlook is shown.' },
      { category: 'improvement', text: 'The "How activities roll up" help next to the CRM link now explains HubSpot\'s rules on HubSpot: Deals and Leads roll up to their primary Company, and Campaign activities don\'t roll up.' },
    ],
  },
  {
    version: '1.407.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations → CRM: any CRM can be chosen before it is set up. A warning says when the chosen CRM isn\'t connected yet, instead of an error.' },
      { category: 'improvement', text: 'The Salesforce and HubSpot cards both always show, whichever CRM is chosen (including None), with a note on the one that isn\'t the CRM.' },
    ],
  },
  {
    version: '1.406.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'Team Management and User Management follow the CRM: on HubSpot, the Team Manager and user link pickers list HubSpot owners, and a team links to HubSpot teams instead of Salesforce departments.' },
      { category: 'improvement', text: 'A user linked to a HubSpot owner by hand in User Management uses that owner everywhere, even when the emails differ.' },
      { category: 'fix', text: 'Historical Import and History read Meetings and Companies on HubSpot; the MFA backup-code count shows again in User Management.' },
    ],
  },
  {
    version: '1.405.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'Activity Types → Salesforce Extras follow the CRM: on HubSpot, an Opp field shows a Deal property on the activity form, and can be edited there when set to read & write.' },
      { category: 'improvement', text: 'Extras made for the other CRM stay saved and are marked "only on Salesforce/HubSpot" instead of breaking the form.' },
    ],
  },
  {
    version: '1.404.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'CRM Field Mappings has a Salesforce / HubSpot toggle. It opens on the active CRM, and you can switch to set up the other CRM\'s mappings ahead of time.' },
      { category: 'improvement', text: 'Validate & dry run checks whichever CRM the toggle shows, and a note says when those mappings aren\'t in use yet.' },
    ],
  },
  {
    version: '1.403.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'The CRM\'s name follows Admin → Integrations → CRM everywhere: a HubSpot install reads "HubSpot" where it used to read "Salesforce" or "SF", and a future CRM needs no wording changes.' },
      { category: 'improvement', text: 'Admin → SF Field Mappings is now CRM Field Mappings.' },
      { category: 'improvement', text: 'Suggested-meeting chips name Deals and Companies on HubSpot, and their labels are translated in every language.' },
    ],
  },
  {
    version: '1.402.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'The MCP server\'s CRM tools work on HubSpot as well as Salesforce: search your Opportunities (Deals), search Accounts (Companies), and read one record\'s live state.' },
      { category: 'feature', text: 'New tool names crm.search_opportunities, crm.search_accounts and crm.get_record; salesforce.search_opportunities stays as an alias.' },
      { category: 'improvement', text: 'Every result names the CRM it came from, and errors come back as plain codes an agent can act on.' },
    ],
  },
  {
    version: '1.401.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'The historical import works on HubSpot: it brings in HubSpot meetings from before ImpactIQ linked to a Deal, Company or Project, with estimated hours kept out of cost and capacity.' },
      { category: 'improvement', text: 'Exclusions take HubSpot owners, users or integrations, and the nightly refresh keeps open historical Deals current.' },
      { category: 'improvement', text: 'My History matches you to your HubSpot owner by email.' },
    ],
  },
  {
    version: '1.400.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'On HubSpot, calendar cards and the activity form suggest the Deal or Company from meeting attendees, and the Attendees section searches the linked Company\'s contacts.' },
      { category: 'feature', text: 'Attach Rate works on HubSpot: a nightly job reads Deal coverage from the properties set under Attach Rate Fields.' },
      { category: 'improvement', text: 'Sales Team Alignment and the Sales Team Breakdown dashboard use HubSpot owners.' },
    ],
  },
  {
    version: '1.399.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'On HubSpot, a nightly check flags activities whose Deal, Company, Contact, Lead or Project was deleted in HubSpot, and the activity drawer checks its own links live when opened.' },
      { category: 'feature', text: 'When HubSpot records are merged, ImpactIQ moves every activity on the old record to the surviving one instead of flagging it, and logs the move.' },
      { category: 'improvement', text: 'Relink, Activities Disconnected and Closed Lost: Needs Review now work on HubSpot Deals, with Deal and Company wording.' },
    ],
  },
  {
    version: '1.398.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'On HubSpot, an activity can link a Project: HubSpot\'s standard Projects object or a custom object, listed from the Deal\'s associated records.' },
      { category: 'improvement', text: 'The Project panel reads and edits its status, stage, type and dates, and Engineer Notes / Next Steps post a dated entry, all through your HubSpot Field Mappings.' },
      { category: 'improvement', text: 'A nightly refresh keeps linked Projects current and flags one HubSpot no longer has.' },
    ],
  },
  {
    version: '1.397.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'On HubSpot, the activity form\'s Assigned SE picker reads and changes the Deal property your team maps as assigned_se_write (a HubSpot user, dropdown or text property).' },
      { category: 'security', text: 'Only people whose email matches a HubSpot user can change a Deal from ImpactIQ; everyone else sees the value read only.' },
      { category: 'feature', text: 'An activity\'s ACV is written to its HubSpot Deal after it syncs, when the team maps a writable acv property.' },
    ],
  },
  {
    version: '1.396.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'On HubSpot, Campaigns and Leads stay hidden when the portal doesn\'t have them (Campaigns need Marketing Hub), even with their switch on, and Admin → CRM features says why.' },
      { category: 'improvement', text: 'A Company\'s Include All view now adds activities on Leads linked to that Company on HubSpot.' },
      { category: 'feature', text: 'A HubSpot meeting linked to a Campaign is added to that campaign in HubSpot (needs Marketing Hub and the marketing.campaigns.write scope).' },
    ],
  },
  {
    version: '1.395.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'On HubSpot, the activity form, hover previews, deleted-meeting review and My Notes say HubSpot instead of Salesforce.' },
      { category: 'improvement', text: 'The Deal and Company hover preview links straight to the record in HubSpot.' },
      { category: 'improvement', text: 'Find matching records in My Notes works on HubSpot, suggesting Deals, Companies and Campaigns.' },
      { category: 'improvement', text: 'Admin → Activity Types\' CRM extras are fully translated, and only the options that work with HubSpot are offered there.' },
    ],
  },
  {
    version: '1.394.0',
    date: '2026-10-22',
    highlights: [
      { category: 'improvement', text: 'On HubSpot, Post: Opp/Acct Notes and My Notes\' Push button add the note to the HubSpot Deal or Company.' },
      { category: 'feature', text: 'The Support Tickets picker works with HubSpot Tickets: the linked Company\'s open tickets by default, Show Closed and Open Search, no setup needed.' },
      { category: 'improvement', text: 'Deleting an activity also deletes its HubSpot meeting or task.' },
      { category: 'improvement', text: 'CRM Sync explains HubSpot errors in plain words, and sync labels say HubSpot instead of Salesforce.' },
    ],
  },
  {
    version: '1.393.1',
    date: '2026-10-22',
    highlights: [
      { category: 'fix', text: 'Tests now always run against the source code, so a leftover local build can no longer make the AI Assistant tests fail.' },
    ],
  },
  {
    version: '1.393.0',
    date: '2026-10-22',
    highlights: [
      { category: 'feature', text: 'HubSpot installs get a nightly Deal refresh: stage, forecast, amount, close date, owner, SE and Company stay current on logged activities.' },
      { category: 'improvement', text: 'Dashboard Deal Stage and Forecast filters list your HubSpot pipelines\' stages, grouped by pipeline, and the Refresh button now works on HubSpot.' },
      { category: 'improvement', text: 'Total Cost of Engagement by Account works on HubSpot, using the Deal\'s Company.' },
    ],
  },
  {
    version: '1.392.2',
    date: '2026-10-21',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations is reordered: Okta SSO, Azure SSO, Microsoft Graph and Email first, then the CRM section and Projects (POC|POV), then Slack, App Updates and Rate Limiting.' },
      { category: 'improvement', text: 'The CRM section now starts collapsed, like Projects and Rate Limiting.' },
    ],
  },
  {
    version: '1.392.1',
    date: '2026-10-21',
    highlights: [
      { category: 'improvement', text: 'AI Assistant\'s Usage this month now opens with four totals: requests, input tokens, output tokens, and estimated cost against the monthly budget.' },
      { category: 'improvement', text: 'The per-provider breakdown only shows when more than one provider has been used this month.' },
    ],
  },
  {
    version: '1.392.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'New Admin → Integrations → AI Assistant page: connect Anthropic, Azure OpenAI, OpenAI, Amazon Bedrock, Microsoft Foundry, Google Gemini or xAI, test each one, and pick the default.' },
      { category: 'improvement', text: 'A master switch, a monthly budget (AI pauses and App Admins get one email when it is reached) and a usage log with estimated cost.' },
      { category: 'feature', text: 'With two or more active providers, choose which one each AI feature uses.' },
      { category: 'improvement', text: 'Calendar activity-type suggestions are cached, so the same meeting is only sent to the AI once. The Setup wizard\'s AI step now offers every provider.' },
    ],
  },
  {
    version: '1.391.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'With HubSpot as the CRM, field mappings list HubSpot objects and your portal\'s own properties, with their types and options.' },
      { category: 'improvement', text: 'Validate & dry run checks each HubSpot mapping against your portal and previews the exact properties a sync would send.' },
      { category: 'improvement', text: 'Sample record shows one real HubSpot record with the mapped properties filled in.' },
    ],
  },
  {
    version: '1.390.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'HubSpot can now be chosen as the CRM once it is connected: search Deals, Companies and Contacts (plus Leads and Campaigns when your portal has them) from the activity form.' },
      { category: 'improvement', text: 'Hovering a Deal or Company link shows its current HubSpot details.' },
      { category: 'feature', text: 'Submitted activities are written to HubSpot as meetings or tasks, linked to the Deal, Company and contacts, and retried on failure.' },
      { category: 'improvement', text: 'Admin → Integrations groups the CRM cards in one collapsible section; Projects and Rate Limiting collapse too and show their status in the header.' },
    ],
  },
  {
    version: '1.389.2',
    date: '2026-10-21',
    highlights: [
      { category: 'improvement', text: 'The HubSpot card on Admin → Integrations is now always listed next to Salesforce, laid out like the other integration cards, so HubSpot can be connected before it is chosen as the CRM.' },
      { category: 'improvement', text: 'Before a key is saved, the card lists every HubSpot scope to grant, with the optional ones marked.' },
    ],
  },
  {
    version: '1.389.1',
    date: '2026-10-21',
    highlights: [
      { category: 'improvement', text: 'The HubSpot connection card now accepts a HubSpot service key as well as a private app token, and says where to create one.' },
      { category: 'improvement', text: 'Check access names the tickets scope as crm.objects.tickets.read, the name HubSpot shows for service keys.' },
      { category: 'improvement', text: 'When HubSpot doesn\'t return a portal name, the card shows the portal\'s domain instead of a dash.' },
    ],
  },
  {
    version: '1.389.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'New HubSpot connection card under Admin → Integrations: paste a HubSpot private app token, which is checked with HubSpot and stored encrypted.' },
      { category: 'improvement', text: 'Check access lists what the token can do (deals, companies, contacts, owners, meetings and more) and which scope to add for anything missing, without changing any HubSpot data.' },
      { category: 'feature', text: 'HubSpot owners are copied daily (or with Sync owners) and ImpactIQ users are matched to them by email; the card lists anyone without a match.' },
      { category: 'improvement', text: 'Groundwork only: HubSpot can\'t be chosen as the CRM yet. Searching and logging to HubSpot come next.' },
    ],
  },
  {
    version: '1.388.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'CriteriaIQ can now be the primary Project source (Admin → Integrations → Projects (POC|POV)), once CriteriaIQ is connected.' },
      { category: 'improvement', text: 'With CriteriaIQ as primary, the activity form\'s Project picker suggests the CriteriaIQ projects named for the linked Opportunity and can search any other; the suggested-meeting card offers the same suggestions.' },
      { category: 'improvement', text: 'A nightly job refreshes each linked CriteriaIQ project and flags a project that was deleted; Won w/o POC and Project-Specific Costing work from CriteriaIQ links.' },
      { category: 'improvement', text: 'Engineer Notes posting is off with CriteriaIQ as primary, since it writes to the CRM Evaluation object.' },
    ],
  },
  {
    version: '1.387.0',
    date: '2026-10-21',
    highlights: [
      { category: 'feature', text: 'Projects can now be turned Off (Admin → Integrations → Projects (POC|POV)).' },
      { category: 'improvement', text: 'With Projects off, the Project picker, Project chips, Engineer Notes posting and the Won w/o POC and Project-Specific Costing dashboards are hidden, and the server refuses new Project links.' },
      { category: 'improvement', text: 'Saved Project links are kept and come back when Projects are turned on again.' },
    ],
  },
  {
    version: '1.386.1',
    date: '2026-10-20',
    highlights: [
      { category: 'improvement', text: 'The Admin → Integrations Project source card is now titled "Projects (POC|POV)".' },
    ],
  },
  {
    version: '1.386.0',
    date: '2026-10-20',
    highlights: [
      { category: 'feature', text: 'CriteriaIQ can now run beside the CRM as a secondary Project source (Admin → Integrations → Projects (Evaluations)).' },
      { category: 'improvement', text: 'With it on, a linked Project on the activity drawer shows its CriteriaIQ project: criteria progress, status, and a link to open it in CriteriaIQ.' },
      { category: 'improvement', text: 'A Project with one matching CriteriaIQ project links on its own; with several, you choose once and everyone sees the same choice. If CriteriaIQ disagrees with the CRM on status, dates or Primary Engineer, the drawer flags it and keeps the CRM value.' },
    ],
  },
  {
    version: '1.385.0',
    date: '2026-10-20',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations has a new Projects (Evaluations) card: where activities\' Projects come from, and whether CriteriaIQ also runs beside the CRM. The CRM Evaluation object stays the source for now; the CriteriaIQ options arrive with the CriteriaIQ project picker.' },
      { category: 'feature', text: 'Connect CriteriaIQ with its URL and a read-only API key (stored encrypted), test the connection, and look up which CriteriaIQ projects point at a Salesforce Evaluation.' },
      { category: 'improvement', text: 'The Project source locks once activities link to Projects, the same rule as the CRM choice.' },
    ],
  },
  {
    version: '1.384.0',
    date: '2026-10-20',
    highlights: [
      { category: 'feature', text: 'Admin → Integrations has a new CRM card for choosing the app\'s CRM (Salesforce or None; HubSpot is coming). The Setup wizard asks the same question.' },
      { category: 'improvement', text: 'Once activities link to CRM records the choice is locked to that CRM, so links never point at a CRM that can\'t read them. Switching to None and back is still allowed.' },
      { category: 'improvement', text: 'With no CRM chosen, Salesforce reads as not configured everywhere and its connect buttons are hidden.' },
    ],
  },
  {
    version: '1.383.0',
    date: '2026-10-20',
    highlights: [
      { category: 'improvement', text: 'Groundwork for HubSpot: Salesforce search, previews, write-back and the snapshot refresh now run through one CRM provider layer. Nothing changes for Salesforce users.' },
      { category: 'improvement', text: 'A new install-wide CRM setting (Salesforce by default) decides which CRM the app talks to. When it names a different CRM, Salesforce routes and background jobs stand down.' },
    ],
  },
  {
    version: '1.382.0',
    date: '2026-10-20',
    highlights: [
      { category: 'feature', text: 'Admin → Integrations → CRM features now has a Leads switch next to Campaigns. It is on by default.' },
      { category: 'improvement', text: 'Turning Leads off hides the Lead search tab, the Leads scope on Most Expensive, the Leads column on Team-of-Teams Rollup, and converted Leads in the Account rollup.' },
      { category: 'improvement', text: 'With Leads off, the server refuses new Lead links on activities. Activities already linked to a Lead keep their link.' },
    ],
  },
  {
    version: '1.381.0',
    date: '2026-10-20',
    highlights: [
      { category: 'feature', text: 'New app-wide Campaigns switch under Admin → Integrations → CRM features. Turning it off hides Campaign search, the Campaign scope on Most Expensive, and the Campaigns column on Team-of-Teams Rollup.' },
      { category: 'improvement', text: 'With Campaigns off, the server refuses new Campaign links on activities. Activities already linked to a Campaign keep their link.' },
      { category: 'improvement', text: 'First step toward HubSpot as an alternative CRM: the switch will cover HubSpot Marketing Hub campaigns too.' },
    ],
  },
  {
    version: '1.380.3',
    date: '2026-10-20',
    highlights: [
      { category: 'improvement', text: 'The browser tab now reads "ImpactIQ | Activity to Impact".' },
    ],
  },
  {
    version: '1.380.2',
    date: '2026-10-20',
    highlights: [
      { category: 'security', text: 'Security: the dev-only tool concurrently is updated to 9.2.5, which pulls in shell-quote 1.12.0 and closes a critical command-injection alert (production builds never included it).' },
    ],
  },
  {
    version: '1.380.1',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'Sidebar: the ImpactIQ name now lines up with the top of the logo, with the version number right under it, like VectorIQ.' },
      { category: 'improvement', text: 'Page header: the dash before a page description now sits in the middle of the text in every font.' },
    ],
  },
  {
    version: '1.380.0',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'The page title in the header bar now matches VectorIQ: a bold, larger title and a larger icon.' },
      { category: 'improvement', text: 'The title icon takes the theme\'s color in light and dark mode, set per theme under Admin → Themes (Page title icon).' },
      { category: 'improvement', text: 'The description after the title is smaller and muted, like VectorIQ\'s.' },
    ],
  },
  {
    version: '1.379.4',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'The version number now sits under the ImpactIQ name in the sidebar, right-aligned, matching VectorIQ.' },
    ],
  },
  {
    version: '1.379.3',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'The CRM and Outlook calendar status icons are now centered in the collapsed sidebar.' },
      { category: 'improvement', text: 'The sidebar reads "CRM not configured" instead of "SF not configured", ready for other CRMs such as HubSpot.' },
    ],
  },
  {
    version: '1.379.2',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'The collapsed sidebar is now 80px wide, the same as VectorIQ, so the collapse button sits clear of the logo.' },
      { category: 'improvement', text: 'Sidebar icons are larger (20px), matching VectorIQ, and the collapsed logo is 40px.' },
    ],
  },
  {
    version: '1.379.1',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'Sidebar collapse button now matches VectorIQ: a panel icon next to the ImpactIQ name when expanded, and a small round badge on the logo corner when collapsed.' },
    ],
  },
  {
    version: '1.379.0',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'Themes: the preset starting points now match VectorIQ, adding Darker Purple and Dark. Dark Blue, Dark Purple and Dark Green now keep a dark sidebar in both modes.' },
      { category: 'improvement', text: 'Each preset chip now shows the light-mode sidebar, the dark-mode sidebar and the button color.' },
      { category: 'improvement', text: 'Buttons with a very light color (such as the Gray and Dark presets in dark mode) now use dark text so they stay readable.' },
    ],
  },
  {
    version: '1.378.0',
    date: '2026-10-16',
    highlights: [
      { category: 'improvement', text: 'Admin: the page header now spans the full width next to the main sidebar, with the Admin menu below it.' },
    ],
  },
  {
    version: '1.377.3',
    date: '2026-10-07',
    highlights: [
      { category: 'improvement', text: 'The login screen logo now appears once at its final size. Before, the theme logo briefly showed in its place (smaller) until the login logo finished loading' },
    ],
  },
  {
    version: '1.377.2',
    date: '2026-10-06',
    highlights: [
      { category: 'fix', text: 'Fixed: saving theme header logos (and other admin uploads) larger than ~190 KB failed with "HTTP 413". The app\'s small default request limit was rejecting them before the admin pages\' 8 MB limit applied; logos up to the stated 2 MB now save.' },
    ],
  },
  {
    version: '1.377.1',
    date: '2026-10-06',
    highlights: [
      { category: 'improvement', text: 'The login screen logo now fills its configured size: empty borders and a plain or gradient background baked into the uploaded image are trimmed away automatically' },
      { category: 'fix', text: 'Adding a login logo no longer pushes the sign-in card down; the logo sits above the centered card and shrinks to fit on short screens' },
    ],
  },
  {
    version: '1.377.0',
    date: '2026-10-06',
    highlights: [
      { category: 'improvement', text: 'The Guide now lists every active Activity Type with its icon and icon color, including types added later that have no Guide text yet' },
      { category: 'improvement', text: 'Existing installs get the default icon and color on the ten default Activity Types automatically, without clicking Seed Default Content (blanks only, an admin pick is never changed)' },
    ],
  },
  {
    version: '1.376.0',
    date: '2026-10-06',
    highlights: [
      { category: 'improvement', text: 'The ten default Activity Types now come with an icon and icon color on a new install and for every new team' },
      { category: 'improvement', text: 'Seed Default Content (Admin → Activity Types) fills in the default icon and color on any default type that has none, and never changes ones an admin already picked' },
    ],
  },
  {
    version: '1.375.0',
    date: '2026-10-05',
    highlights: [
      { category: 'feature', text: 'New Backup & Restore page (Admin → Monitoring & Audit, App Admins): download a full copy of the database' },
      { category: 'improvement', text: 'Restore a backup into a new install: preview what it contains, type RESTORE to confirm, and it all happens in one step that rolls back if anything fails' },
      { category: 'improvement', text: 'Environment variables and secrets stay with each install and are never part of a backup' },
    ],
  },
  {
    version: '1.374.0',
    date: '2026-10-05',
    highlights: [
      { category: 'feature', text: 'Admin → Activity Types now has Export and Import buttons next to Seed Default Content' },
      { category: 'improvement', text: 'Export saves every activity type with its icon, color, subtypes, Salesforce Extras, Classify Activity text and the team\'s Guide Distinctions in one file' },
      { category: 'improvement', text: 'Import shows a preview of what will be added and updated before anything changes, matches types by name, and never deletes a type or subtype' },
    ],
  },
  {
    version: '1.373.0',
    date: '2026-10-05',
    highlights: [
      { category: 'improvement', text: 'The Login screen logo now shows much larger by default: 750 × 200 for a wide logo, 250 × 250 for a square one' },
      { category: 'feature', text: 'New Display size setting under Admin → Themes → Login screen logo lets you set your own width and height' },
      { category: 'improvement', text: 'The logo keeps its proportions and shrinks to fit on narrow screens' },
    ],
  },
  {
    version: '1.372.0',
    date: '2026-10-04',
    highlights: [
      { category: 'feature', text: 'New app-wide Login screen logo (Admin → Themes): set the large logo shown above the sign-in card, independent of any theme' },
      { category: 'improvement', text: 'When no login logo is set, the login screen keeps using the active theme\'s logo as before' },
    ],
  },
  {
    version: '1.371.0',
    date: '2026-09-30',
    highlights: [
      { category: 'improvement', text: 'The app is now fully vendor-neutral: company-specific names, hostnames and example values were removed from the UI, setup wizard, docs and all 7 languages' },
      { category: 'feature', text: 'New Support contact email setting (Admin → Themes): the help icon on login and in the header now uses it, and is hidden until one is configured' },
      { category: 'improvement', text: 'The default theme created on a fresh install is now named "Default"' },
    ],
  },
  {
    version: '1.370.0',
    date: '2026-09-22',
    highlights: [
      { category: 'improvement', text: 'Editing an activity past its 90-day window now shows a clear message (App Admins can still edit any activity)' },
      { category: 'improvement', text: 'Rewrote the How to Use ImpactIQ overview and removed em dashes from its prose throughout' },
    ],
  },
  {
    version: '1.369.0',
    date: '2026-09-22',
    highlights: [
      { category: 'improvement', text: "A pending deleted-Outlook-meeting activity now shows its title in red in the day list, not just in the review card above" },
      { category: 'fix', text: 'Fixed the required-field asterisk so the whole "Fields marked with *" note renders in red, not just part of it' },
    ],
  },
  {
    version: '1.368.1',
    date: '2026-09-22',
    highlights: [
      { category: 'fix', text: 'Watermark fix corrected: restored the original graphic size/crop, with a matching fill color for the extra scrolled space (no more stretching)' },
      { category: 'improvement', text: 'How to Use ImpactIQ now matches the same content width as every other page' },
    ],
  },
  {
    version: '1.368.0',
    date: '2026-09-22',
    highlights: [
      { category: 'fix', text: 'Fixed the world-map watermark not covering the full page on long screens (Guide, How to Use, Admin, My Settings)' },
      { category: 'improvement', text: 'How to Use ImpactIQ: added Leads/Campaigns linking, Subtypes, travel costs, broken-link recovery, Scheduling, and My Notes sections' },
      { category: 'fix', text: 'Translated a handful of stale English strings found in the Account-relationship help popover (DE/FR/JA)' },
    ],
  },
  {
    version: '1.367.1',
    date: '2026-09-22',
    highlights: [
      { category: 'fix', text: 'Fixed: "This Week\'s Deleted Activities" section could vanish after navigating away and back to a week (stale fetch race)' },
    ],
  },
  {
    version: '1.367.0',
    date: '2026-09-22',
    highlights: [
      { category: 'feature', text: 'New in-app "How to Use ImpactIQ" onboarding manual, linked from the top of the Guide page' },
      { category: 'improvement', text: 'README and /docs refreshed for currency (v1.350–v1.366 features, theme presets, security fixes)' },
    ],
  },
  {
    version: '1.366.0',
    date: '2026-09-18',
    highlights: [
      { category: 'security', text: 'Fixed all 10 open Dependabot security alerts (fast-uri, hono, qs, csv-parse)' },
      { category: 'security', text: 'No functional changes — every fix is a same-major-version patch/minor bump pinned via npm overrides' },
    ],
  },
  {
    version: '1.365.0',
    date: '2026-09-18',
    highlights: [
      { category: 'improvement', text: '4 new Theme presets: Gray, Teal, Crimson, and Dark Green' },
      { category: 'improvement', text: 'Dark Green completes the Dark Purple / Dark Blue / Dark Yellow family alongside Forest Green' },
    ],
  },
  {
    version: '1.364.0',
    date: '2026-09-17',
    highlights: [
      { category: 'fix', text: 'Fixed the world-map watermark bleeding through CRM Sync and Nudge History tables' },
      { category: 'improvement', text: 'The sidebar user pill now shows a "Last logged in" tooltip in your own timezone' },
      { category: 'improvement', text: 'Login History now has its own 60-day retention cull' },
    ],
  },
  {
    version: '1.363.0',
    date: '2026-09-17',
    highlights: [
      { category: 'improvement', text: 'The month heatmap now shows a red dot on days with an activity awaiting a Keep/Delete decision after its Outlook meeting was deleted' },
      { category: 'improvement', text: 'The Outlook Calendar week view turns that day\'s number red too, with a hover tooltip explaining why' },
    ],
  },
  {
    version: '1.362.0',
    date: '2026-09-17',
    highlights: [
      { category: 'fix', text: 'The deleted-Outlook-meeting banner\'s Review link now takes you to the actual week the flagged activity is in, not always today' },
      { category: 'feature', text: 'New leader dashboard: Activities Disconnected from Outlook, matching the existing Activities Disconnected from SF dashboard' },
    ],
  },
  {
    version: '1.361.0',
    date: '2026-09-16',
    highlights: [
      { category: 'improvement', text: 'Every color picker in the app (Themes, Activity Types, Flight Deck) now uses the same swatch + hex + gradient picker' },
      { category: 'feature', text: 'Added an eyedropper button to that shared picker to pick a color straight off the screen' },
    ],
  },
  {
    version: '1.360.0',
    date: '2026-09-16',
    highlights: [
      { category: 'improvement', text: 'My Settings now lives as an icon button next to Logout, not a regular sidebar link' },
      { category: 'improvement', text: 'Light/Dark/System theme choice moved from the sidebar into My Settings → Preferences' },
    ],
  },
  {
    version: '1.359.0',
    date: '2026-09-16',
    highlights: [
      { category: 'improvement', text: 'Header quarter-countdown pill now shows business days AND calendar days left (e.g. "32/45"), with a hover explaining each' },
    ],
  },
  {
    version: '1.358.1',
    date: '2026-09-16',
    highlights: [
      { category: 'fix', text: 'Fixed: the sidebar app name color (Admin → Themes) wasn\'t actually saving on any theme' },
    ],
  },
  {
    version: '1.358.0',
    date: '2026-09-16',
    highlights: [
      { category: 'feature', text: 'Admin → Themes: the sidebar "ImpactIQ" app name text now has its own configurable light/dark color' },
    ],
  },
  {
    version: '1.357.0',
    date: '2026-09-16',
    highlights: [
      { category: 'improvement', text: 'Admin → Themes: 4 new preset starting points — Purple, Dark Purple, Dark Blue, and Dark Yellow' },
    ],
  },
  {
    version: '1.356.0',
    date: '2026-09-16',
    highlights: [
      { category: 'security', text: 'Security hardening: role management, team-scoped admin configuration, and Salesforce/Azure OpenAI integration settings now enforce stricter access and destination checks' },
    ],
  },
  {
    version: '1.355.0',
    date: '2026-09-16',
    highlights: [
      { category: 'fix', text: 'Fixed the world-map background watermark (Admin, My Settings, Guide) being invisible in dark mode — it was screen-blending the same near-black image light mode multiplies onto a white background, which had nothing to lighten with; now inverted first so it shows up the same way it always has in light mode' },
    ],
  },
  {
    version: '1.354.0',
    date: '2026-09-08',
    highlights: [
      { category: 'improvement', text: 'My Settings and Guide now show the same world-map background watermark as the Admin pages, for a consistent look across the app' },
    ],
  },
  {
    version: '1.353.0',
    date: '2026-09-06',
    highlights: [
      { category: 'security', text: 'Setup wizard: the initial Admin Account password now requires the same complexity as every other password in the app (10+ chars, upper/lower/number/special), enforced on both the form and the server — previously it only checked length >= 8' },
      { category: 'improvement', text: 'The password field shows a live, real-time checklist of each requirement as you type, same as the existing change-password screen' },
    ],
  },
  {
    version: '1.352.0',
    date: '2026-09-05',
    highlights: [
      { category: 'improvement', text: 'Setup wizard now shares the same branded blue background (with the world watermark) as the Login screen, instead of a plain gray page' },
      { category: 'improvement', text: 'Removed all Dokploy-specific wording from the Setup wizard — the DB connection hint and the final "copy your env vars" step now use platform-neutral language' },
    ],
  },
  {
    version: '1.351.0',
    date: '2026-09-05',
    highlights: [
      { category: 'improvement', text: 'Notes fields (Log Activity, Notes tab, My Notes) now show a small info icon explaining the Markdown formatting they support — bold, italic, headings, lists, links, code, and blockquotes, each with a live rendered preview' },
    ],
  },
  {
    version: '1.350.0',
    date: '2026-09-05',
    highlights: [
      { category: 'improvement', text: 'MCP: docs/mcp.md now covers connecting from claude.ai\'s web Connectors, including a real limitation of that surface today (no field for a Bearer token) and the reliable fallbacks' },
      { category: 'improvement', text: 'My Settings → API Keys: creating an mcp:read key now shows a ready-to-paste Claude Desktop/Code config with your real key filled in' },
      { category: 'improvement', text: 'Admin → Integrations → MCP Server: added the same web-Connectors setup steps alongside the existing n8n/Claude Desktop snippets' },
    ],
  },
  {
    version: '1.349.6',
    date: '2026-09-02',
    highlights: [
      { category: 'security', text: 'Security fix: closed an incomplete-SOQL-escaping issue in Opportunity Relink flagged by GitHub Code Scanning' },
    ],
  },
  {
    version: '1.349.5',
    date: '2026-09-02',
    highlights: [
      { category: 'fix', text: 'Fix: a still-active announcement no longer piles up a duplicate banner/bell entry each day it stays active — only today\'s row is ever kept' },
    ],
  },
  {
    version: '1.349.4',
    date: '2026-09-01',
    highlights: [
      { category: 'improvement', text: 'Announcements: pick a custom icon and light/dark colors for the top-header banner (bell and toast still use the plain severity icon)' },
      { category: 'fix', text: 'Fix: the bottom-of-screen notification toast now shows a real Info/Warning/Critical icon and matching green/orange/red background instead of always plain blue' },
    ],
  },
  {
    version: '1.349.3',
    date: '2026-09-01',
    highlights: [
      { category: 'fix', text: 'Fix: closed a ~48px gray gap between the sidebar and the Admin page\'s world-map watermark on wide windows' },
    ],
  },
  {
    version: '1.349.2',
    date: '2026-09-01',
    highlights: [
      { category: 'fix', text: 'Fix: URLs and email addresses in announcement/notification messages are now clickable links instead of dead text' },
      { category: 'fix', text: 'Fix: a long link in an announcement now wraps within its card instead of overflowing' },
    ],
  },
  {
    version: '1.349.1',
    date: '2026-09-01',
    highlights: [
      { category: 'fix', text: 'Fix: deleting an announcement, or editing its dates so it\'s no longer active, now removes it from the banner and notification bell right away instead of it lingering indefinitely' },
    ],
  },
  {
    version: '1.349.0',
    date: '2026-09-01',
    highlights: [
      { category: 'feature', text: 'New Admin → Workplace → Announcements: Admins/Team Admins/Leaders can post a message to a team, a subteam, or one specific person' },
      { category: 'improvement', text: 'Announcements show in the top banner and the notification bell until dismissed; an optional "reappear daily" setting brings a dismissed announcement back the next morning (your own local time) until its end date' },
      { category: 'improvement', text: 'Leaders can only target a subteam they lead or a specific person — team-wide announcements are Team Admin/App Admin only' },
    ],
  },
  {
    version: '1.348.0',
    date: '2026-09-01',
    highlights: [
      { category: 'fix', text: 'Fix: viewing a colleague\'s Outlook calendar when they\'re not connected no longer shows a duplicate raw error message — the banner now leads with "Outlook Not Connected!"' },
      { category: 'feature', text: 'User Management: new Connections column shows Salesforce/Outlook status icons per user, with an opt-in Verify button for an on-demand live check' },
    ],
  },
  {
    version: '1.347.0',
    date: '2026-09-01',
    highlights: [
      { category: 'improvement', text: 'Themes: the "Brand Palette" is now a real, assignable Theme like any other — every install always has exactly one Active theme, no separate fallback system' },
      { category: 'fix', text: 'A theme can no longer be deleted or deactivated if it\'s the last one or the currently active one, so the app can never end up with zero themes' },
      { category: 'fix', text: 'Admin → Themes now shows a clear error message when a theme action fails, instead of silently doing nothing' },
    ],
  },
  {
    version: '1.346.0',
    date: '2026-09-01',
    highlights: [
      { category: 'improvement', text: 'Login: Okta and Microsoft sign-in are now one "Sign in with Identity Provider" button — if only one is configured it goes straight through, and if both are configured it opens a small picker with an option to remember your choice on this device' },
      { category: 'fix', text: 'Fix: Team Management\'s theme dropdown now names the actual current org-default theme in its "Inherit org default" option instead of a placeholder that never changed' },
    ],
  },
  {
    version: '1.345.0',
    date: '2026-08-31',
    highlights: [
      { category: 'feature', text: 'New: Opportunity Relink — a Leader/Admin can bulk-move every ImpactIQ activity from an Opportunity closed Lost/Duplicate onto its real replacement, re-queuing the matching Salesforce Event/Task records for write-back' },
      { category: 'feature', text: 'New Manager dashboard: Closed Lost — Needs Review, a live queue of closed Lost/Duplicate Opportunities that still have ImpactIQ activity linked, with a Dismiss action for genuinely-fine cases' },
    ],
  },
  {
    version: '1.344.0',
    date: '2026-08-31',
    highlights: [
      { category: 'feature', text: 'New Activity dashboard: Activities Disconnected from SF — lists activities whose linked Salesforce Account, Opportunity, Campaign, Contact, Lead, or Related record has been deleted, with a link to the activity and to the last-known Salesforce record' },
      { category: 'improvement', text: 'A nightly job now scans every activity for broken Salesforce links; opening an activity in the edit drawer also runs a live check for that one record' },
      { category: 'improvement', text: 'Activity cards show a new "SF link broken" badge when a linked Salesforce record can no longer be found' },
    ],
  },
  {
    version: '1.343.0',
    date: '2026-08-31',
    highlights: [
      { category: 'improvement', text: 'Scheduling: the Free Time panel gets a third PTO toggle alongside Common/Per User, listing just the team members who are out each day' },
    ],
  },
  {
    version: '1.342.1',
    date: '2026-08-31',
    highlights: [
      { category: 'security', text: 'Security hardening: the Support Ticket search endpoint now validates the `q`/`accountId` query parameters are genuinely strings before using them, closing a type-confusion finding flagged by CodeQL' },
    ],
  },
  {
    version: '1.342.0',
    date: '2026-08-31',
    highlights: [
      { category: 'improvement', text: 'Approved activities with attached Support Tickets now show a flush red rail on the right edge of the card' },
      { category: 'fix', text: 'Fixed: clicking a Weekly Capacity activity-type chip to filter the day list no longer silently stays applied after navigating to another week' },
    ],
  },
  {
    version: '1.341.0',
    date: '2026-08-29',
    highlights: [
      { category: 'improvement', text: 'Already-attached Support Tickets now refresh in the background as soon as the activity drawer opens, so stale fields (e.g. an Owner reassigned to a different person or Queue) self-heal without ever delaying the drawer — a small spinner shows next to Support Tickets while it refreshes' },
    ],
  },
  {
    version: '1.340.0',
    date: '2026-08-29',
    highlights: [
      { category: 'fix', text: 'Fixed: Ticket Owner now correctly shows a name whether the ticket is currently owned by a person or by a Queue, instead of only resolving person owners' },
    ],
  },
  {
    version: '1.339.0',
    date: '2026-08-29',
    highlights: [
      { category: 'fix', text: 'Fixed: Ticket Owner (and Contact, where applicable) now shows the actual name instead of a raw Salesforce Id when the mapped field is a User lookup' },
      { category: 'improvement', text: 'The Support Tickets section now shows directly between the Activity Type row and the Start/End Time row, appearing as soon as a ticket-enabled type is chosen' },
    ],
  },
  {
    version: '1.338.0',
    date: '2026-08-28',
    highlights: [
      { category: 'improvement', text: 'The Support Tickets picker now shows directly under Activity Type and Start/End Time on the Log/Edit Activity drawer, instead of down by the Salesforce Link section' },
      { category: 'improvement', text: 'Validate & Dry Run now automatically picks up any newly-mapped Salesforce object (including read-only ones like the Ticket picker\'s object) instead of only checking objects with a write-capable mapping' },
      { category: 'feature', text: 'Added a "Sample record" button per object in Validate & Dry Run — an on-demand live read showing exactly what each mapped field resolves to on a real Salesforce record' },
    ],
  },
  {
    version: '1.337.0',
    date: '2026-08-28',
    highlights: [
      { category: 'feature', text: 'Support tickets can now be attached to an activity — search Salesforce tickets connected to the linked Account (or search all tickets), attach as many as needed, and click a ticket number to open it in Salesforce' },
      { category: 'improvement', text: 'Admins can turn this on per Activity Type from a new Ticket picker option under Salesforce Extras, and map the ticket fields to show (Number, Subject, Date Opened, Status, Contact, plus Description/Platform/Owner on hover) in SF Field Mappings' },
      { category: 'improvement', text: 'Closed tickets are hidden by default (admin picks which Status values count as closed); a Show Closed checkbox reveals them' },
    ],
  },
  {
    version: '1.336.0',
    date: '2026-08-28',
    highlights: [
      { category: 'improvement', text: 'The Attendees field now shows a red minus button next to each name so you can remove someone with one click, without touching the free-text box' },
      { category: 'feature', text: 'Editing a meeting title now syncs back to your own copy of the Outlook event when you didn\'t organize the meeting' },
      { category: 'feature', text: 'The default admin can now trigger an immediate server restart from Admin → Integrations → App Updates instead of only scheduling one for later' },
    ],
  },
  {
    version: '1.335.0',
    date: '2026-08-28',
    highlights: [
      { category: 'improvement', text: 'The version-chip changelog popover caps Earlier releases at the last 25 instead of showing the entire history' },
      { category: 'fix', text: 'App Updates: a live check right after any server restart keeps the cached update status in sync instead of showing stale "update available" for up to 6 hours' },
      { category: 'improvement', text: 'Start Time, End Time, and Effort Hours are grayed out on the Log/Edit Activity drawer once the activity is linked to an Outlook meeting — the calendar event stays the source of truth' },
      { category: 'fix', text: 'Fixed: setting an End Time before Start Time silently produced a savable 0.0h activity with no warning — now blocked with a clear inline error until fixed' },
      { category: 'improvement', text: 'Products and Subtype are now required fields on the Log/Edit Activity drawer, each independently, whenever the team has them configured' },
    ],
  },
  {
    version: '1.334.0',
    date: '2026-08-28',
    highlights: [
      { category: 'improvement', text: 'The version-chip changelog popover now shows just What\'s New and one combined Earlier releases list instead of two confusingly similar sections' },
      { category: 'feature', text: 'Marketing activities get an optional Event Name field with an example placeholder — ImpactIQ only, never sent to Salesforce' },
      { category: 'improvement', text: 'The Log/Edit Activity drawer now marks required fields with a red * and explains what that means at the top' },
    ],
  },
  {
    version: '1.333.0',
    date: '2026-08-27',
    highlights: [
      { category: 'feature', text: 'App Updates (Phase 2): the default admin can schedule a maintenance-window restart with an optional message — every signed-in user sees an advance notice and a live 30-minute countdown, and the app restarts its own process at the scheduled time' },
    ],
  },
  {
    version: '1.332.0',
    date: '2026-08-27',
    highlights: [
      { category: 'feature', text: 'App Updates (Phase 1): App Admins see a new sidebar pill and a version-chip dot when a newer version is available on the pinned GitHub branch, with a modal showing what changed — read-only for now, only the default admin can configure it or check now' },
    ],
  },
  {
    version: '1.331.1',
    date: '2026-08-27',
    highlights: [
      { category: 'fix', text: 'Fixed the Admin background fix from v1.331.0, which had washed the whole page in gray instead of just closing the edge gap — the watermark now scales with background-size: cover, filling any window size without distortion or an extra tint' },
    ],
  },
  {
    version: '1.331.0',
    date: '2026-08-27',
    highlights: [
      { category: 'improvement', text: 'My Settings groups are now collapsible (Connections open by default) with an expand/collapse-all button, and the Admin pages\' world-map watermark no longer leaves a visible seam on a wide window' },
    ],
  },
  {
    version: '1.330.0',
    date: '2026-08-27',
    highlights: [
      { category: 'improvement', text: 'Login History, Audit Log, and Scheduling now show a CRM-Sync-style KPI row at the top, each surfacing both activity and real gaps (suspicious logins, destructive actions, jobs with no error alert, etc.)' },
    ],
  },
  {
    version: '1.329.0',
    date: '2026-08-27',
    highlights: [
      { category: 'improvement', text: 'Scheduling now shows a Send Window column for the Daily Digest / Weekly Recap jobs, and Run Now displays a live countdown to the next real send opportunity when there\'s nothing to do right now' },
    ],
  },
  {
    version: '1.328.0',
    date: '2026-08-27',
    highlights: [
      { category: 'improvement', text: 'Scheduling → Run Now on the Daily Digest / Weekly Recap jobs now shows honest feedback when the clock-gated send window hasn\'t arrived yet, instead of implying success either way' },
    ],
  },
  {
    version: '1.327.0',
    date: '2026-08-27',
    highlights: [
      { category: 'security', text: 'Dedicated rate limits added to Okta/Azure sign-in and Salesforce/History queries, on top of the existing global limiter' },
    ],
  },
  {
    version: '1.326.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Italian translation gap closed: ~102 keys that held literal English text now hold real Italian' },
      { category: 'fix', text: 'All 7 locales are now fully translated — no locale still carries this defect class' },
    ],
  },
  {
    version: '1.325.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Portuguese translation gap closed: ~125 keys that held literal English text now hold real Portuguese' },
    ],
  },
  {
    version: '1.324.0',
    date: '2026-08-26',
    highlights: [
      { category: 'improvement', text: 'Nudge Rules now have an editable Name, so rules sharing the same trigger type can be told apart' },
      { category: 'feature', text: 'Nudge Dismissals is now a tab on Nudge History (Monitoring & Audit), with 4 new KPI cards: top nudge, top user, most-snoozed nudge, and top snoozing user' },
      { category: 'improvement', text: 'Nudge History gets a new "Nudge" filter and column alongside the existing Trigger filter/column' },
    ],
  },
  {
    version: '1.323.0',
    date: '2026-08-26',
    highlights: [
      { category: 'security', text: 'Password-only accounts can no longer reuse one of their last 5 passwords, and must reset every 90 days' },
      { category: 'improvement', text: 'User Management now shows a Password Reset countdown, and a new Azure/Entra SSO only Sign-in Method option (existing "Password or Okta" is now "All Login Options")' },
    ],
  },
  {
    version: '1.322.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Dashboards granted to a Contributor role via Role Management now actually load data instead of always showing empty' },
      { category: 'fix', text: 'Fixed the days-left-in-quarter chip showing calendar quarters for non-admin users instead of the configured Fiscal Year calendar' },
    ],
  },
  {
    version: '1.321.0',
    date: '2026-08-26',
    highlights: [
      { category: 'security', text: 'Fixed a rare timing bug where the weekly activity list could briefly show another team member\'s activity before your own view loaded' },
      { category: 'improvement', text: 'Meeting owner email now backfills onto the hover tooltip and edit drawer for activities approved before that field existed, when the linked calendar event still matches' },
    ],
  },
  {
    version: '1.320.0',
    date: '2026-08-26',
    highlights: [
      { category: 'feature', text: 'Team Activity Deep-Dive now has a view toggle to switch between Activity Type-first and Subteam-first ordering' },
      { category: 'improvement', text: 'Sales Team Alignment now supports Team Admins and, under All Teams, groups every user by Team and Subteam in collapsible sections' },
    ],
  },
  {
    version: '1.319.0',
    date: '2026-08-26',
    highlights: [
      { category: 'improvement', text: 'Meeting owner now shows its email alongside the name, same as Attendees, so two people who share a name across different orgs can be told apart' },
      { category: 'improvement', text: 'Hovering the Meeting owner name on an activity or suggested-meeting card now shows their email' },
    ],
  },
  {
    version: '1.318.0',
    date: '2026-08-26',
    highlights: [
      { category: 'improvement', text: 'User Management now shows a Last Logged In column for every user' },
      { category: 'improvement', text: 'Under All Teams, User Management now shows every user grouped into collapsible sections by their Default Team, with a Subteam filter per team' },
    ],
  },
  {
    version: '1.317.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Fixed a nudge rule bug where {days} (and several other tokens, when repeated in a custom template) showed up as a literal, unsubstituted token in the delivered message instead of the real number' },
      { category: 'security', text: 'Fixed a bug where editing and saving a user in User Management could silently re-grant App Admin to someone who had just been demoted via the Role dropdown' },
    ],
  },
  {
    version: '1.316.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Japanese translations fixed for ~50 screens/labels that previously showed raw English text (present in the file, just never translated) — brand names, technical abbreviations, currency-range labels, and env var literals were deliberately left as-is' },
    ],
  },
  {
    version: '1.315.0',
    date: '2026-08-26',
    highlights: [
      { category: 'fix', text: 'Spanish translations fixed for ~110 screens/labels that previously showed raw English text (present in the file, just never translated) — brand names, technical abbreviations, and Salesforce object terms already used as loanwords elsewhere in the app were deliberately left as-is' },
    ],
  },
  {
    version: '1.314.0',
    date: '2026-08-25',
    highlights: [
      { category: 'fix', text: 'French translations fixed for ~115 screens/labels that previously showed raw English text (present in the file, just never translated) — brand names, technical abbreviations, and Salesforce object terms already used as loanwords elsewhere in the app were deliberately left as-is' },
    ],
  },
  {
    version: '1.313.0',
    date: '2026-08-25',
    highlights: [
      { category: 'fix', text: 'German translations fixed for ~115 screens/labels that previously showed raw English text (present in the file, just never translated) — brand names, technical abbreviations, and Salesforce object terms already used as loanwords elsewhere in the app were deliberately left as-is' },
    ],
  },
  {
    version: '1.312.0',
    date: '2026-08-25',
    highlights: [
      { category: 'improvement', text: 'All 7 languages (English, German, French, Spanish, Japanese, Portuguese, Italian) are now fully translated with zero missing keys — closes a 149-key gap found by a full audit, including several Italian screens that had been showing raw English text' },
      { category: 'improvement', text: 'Internal: added automated test coverage for Salesforce write-back field mapping, capacity/cost resolution, the leader-dashboard anomaly detector, and the SF Field Mappings Validate & Dry Run checks — no user-facing changes' },
    ],
  },
  {
    version: '1.311.0',
    date: '2026-08-25',
    highlights: [
      { category: 'improvement', text: 'Internal: added real automated test coverage for the nudge engine (in-memory Postgres via pglite), plus a permanent regression guard for the exact bug class behind the recent no_activity_days fix — no user-facing changes' },
    ],
  },
  {
    version: '1.310.0',
    date: '2026-08-25',
    highlights: [
      { category: 'feature', text: 'New Admin → Nudge Dismissals page: see which team members currently have a reminder snoozed or permanently closed out, and clear it for them' },
    ],
  },
  {
    version: '1.309.0',
    date: '2026-08-25',
    highlights: [
      { category: 'fix', text: 'The weekly capacity bar now correctly excludes cancelled and declined meetings from "other meetings" hours, matching the corrected math already used on leader dashboards' },
    ],
  },
  {
    version: '1.308.0',
    date: '2026-08-25',
    highlights: [
      { category: 'fix', text: 'Fixed a bug where "No activity for N days" nudges could never fire for anyone, on any team, regardless of configuration — a strict-equality comparison against a database count was comparing a string to a number' },
      { category: 'improvement', text: 'Post: Opp Notes / Post: Acct Notes checkboxes now sit side by side on one row, each with a hover tooltip explaining exactly what it posts and where' },
    ],
  },
  {
    version: '1.307.0',
    date: '2026-08-25',
    highlights: [
      { category: 'improvement', text: 'Activity Notes now have Post: Opp Notes / Post: Acct Notes checkboxes, right below Engineer Notes, so a note can be pushed to Salesforce Opportunity and/or Account Notes straight from the activity drawer — no trip to My Notes required' },
    ],
  },
  {
    version: '1.306.0',
    date: '2026-08-25',
    highlights: [
      { category: 'improvement', text: 'The Nudge Rules Preview now flags when a rule is secretly configured as a Leader roll-up (which skips per-member matching entirely) or has an AND/OR condition, so a symmetric "0 matches" result no longer looks the same as a genuine per-member miss' },
    ],
  },
  {
    version: '1.305.0',
    date: '2026-08-25',
    highlights: [
      { category: 'improvement', text: 'The Nudge Rules Preview now shows, per member, whether they currently have that exact reminder snoozed or closed out — so a member who should match by the numbers but is excluded anyway shows exactly why' },
    ],
  },
  {
    version: '1.304.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The Nudge Rules Preview now shows exactly how many recent activities the rule\'s own query counted for each member, next to their last-logged-activity date' },
    ],
  },
  {
    version: '1.303.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The Nudge Rules Preview now shows a clear warning when a rule isn\'t actually active or assigned to the team you\'re previewing, instead of silently showing 0 matches' },
    ],
  },
  {
    version: '1.302.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'Audit Log now shows a readable name for SF Field Mapping changes instead of a raw ID, plus names for Subteam and Activity targets' },
      { category: 'improvement', text: 'The Audit Log Action filter now lists every action the app actually logs, not just a partial hand-picked subset' },
    ],
  },
  {
    version: '1.301.0',
    date: '2026-08-24',
    highlights: [
      { category: 'fix', text: 'Fixed the seeded Evaluation lookup mapping to actually respect the SF API field an admin configures, instead of always reading a hardcoded field name' },
    ],
  },
  {
    version: '1.300.0',
    date: '2026-08-24',
    highlights: [
      { category: 'fix', text: 'Fixed several false-positive errors in SF Field Mappings\' Validate & Dry Run check, including a Subject/Type mismatch that showed up on every team' },
      { category: 'fix', text: 'Validate & Dry Run now correctly recognizes Project Engineer Notes, Situation/Next Steps, and Assigned SE write mappings instead of flagging them as unused' },
    ],
  },
  {
    version: '1.299.0',
    date: '2026-08-24',
    highlights: [
      { category: 'feature', text: 'SF Field Mappings now supports Export and Import — download a team\'s full mapping configuration as a file and re-import it into the same or a different team' },
      { category: 'improvement', text: 'Import previews exactly what would change before applying anything, so a stale file can never silently overwrite a more recent edit' },
    ],
  },
  {
    version: '1.298.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The Assigned Oppty SE picker now respects a dedicated SF Field Mappings write-target setting instead of always writing to a hardcoded field' },
      { category: 'feature', text: 'Admins can now configure exactly which Salesforce field the Assigned SE picker reads from and writes to in SF Field Mappings' },
    ],
  },
  {
    version: '1.297.0',
    date: '2026-08-24',
    highlights: [
      { category: 'fix', text: 'Fixed a real bug where a Nudge Rule or Keyword Rule reassigned to a different team via "Assign to teams" would silently stop working for that team — it looked correct in the admin editor but never actually fired or matched' },
      { category: 'fix', text: 'Duplicating a team now correctly copies over its Nudge Rules and Keyword Rules so they show up for the new team' },
    ],
  },
  {
    version: '1.296.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings "Validate & dry run" now checks every Salesforce object with a configured write-back mapping, not just Event/Task' },
      { category: 'fix', text: 'Fixed a bug where marking the ACV mapping read-only had no effect — Salesforce was still being written to using a hardcoded field name' },
    ],
  },
  {
    version: '1.295.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The Nudge Rules Preview now shows each team member\'s actual last-logged-activity date for "no activity" rules, so you can see exactly why someone is or isn\'t matching' },
    ],
  },
  {
    version: '1.294.0',
    date: '2026-08-24',
    highlights: [
      { category: 'fix', text: 'Fixed a real bug where snoozing a nudge from the notification bell could accidentally also close it out forever, silently overriding the snooze duration you picked' },
      { category: 'improvement', text: 'Nudge actions (Mark read, Snooze) now stay in sync across the bell, weekly-view card, and toast no matter which one you use' },
      { category: 'improvement', text: 'Nudges about a stale Opportunity or missing follow-up type can now show the real number of days overdue, not just the configured threshold — add {days_overdue} to a rule\'s message template' },
      { category: 'improvement', text: 'The Total ACV field on the activity form now fully matches the Opp Amount (SF) box next to it, including comma formatting' },
    ],
  },
  {
    version: '1.293.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The activity form\'s Opportunity ACV section is now titled "$ Total Business", with the Sales Stage/Forecast/Close Date summary moved above it, right under the Salesforce link' },
      { category: 'feature', text: 'That summary now has a chevron to expand a New Business / Renewals ACV & TCV breakdown, refreshed live from Salesforce each time it\'s opened' },
      { category: 'improvement', text: 'Admins can map the 4 new business-breakdown fields under Admin → SF Field Mappings' },
    ],
  },
  {
    version: '1.292.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'The bottom-of-screen nudge toast now has Mark read and Snooze buttons with hover explanations, instead of a single unlabeled X' },
      { category: 'improvement', text: 'The weekly-view nudge card now shows Mark read + Snooze (matching the toast and the notification bell) instead of Snooze + a permanent Close out' },
      { category: 'improvement', text: 'Permanently closing out a reminder so it never shows again is now done only from the notification bell — the bell\'s X now closes it out for good, and its hover text says so' },
    ],
  },
  {
    version: '1.291.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'Nudge action buttons (Mark read, Snooze, Dismiss, Close out) now show a clear hover explanation of what clicking them actually does' },
      { category: 'improvement', text: 'Admin Nudge Rules Preview now explains when a rule shows zero hits because members already have it snoozed or closed out, instead of leaving that indistinguishable from a genuinely non-matching rule' },
    ],
  },
  {
    version: '1.290.0',
    date: '2026-08-24',
    highlights: [
      { category: 'improvement', text: 'Dismissing a nudge from the notification bell now actually stops it from reappearing for the rest of the day, instead of silently coming back on the next refresh' },
      { category: 'improvement', text: 'Nudge Rules admin editor now warns when the AND/OR conditions field duplicates the rule\'s own trigger type with a different config, since the stricter one wins silently' },
    ],
  },
  {
    version: '1.289.0',
    date: '2026-08-23',
    highlights: [
      { category: 'security', text: 'Security hardening fast-follows: login and password-reset attempts are now throttled per account (not just per IP), closing a slow distributed-brute-force gap' },
      { category: 'security', text: 'Outbound email templates now HTML-escape substituted values by default, closing an HTML-injection path via profile fields and request headers' },
      { category: 'security', text: 'Theme logo uploads are now restricted to a safe image MIME allowlist with locked-down response headers when served' },
      { category: 'security', text: 'Salesforce Field Mapping create/update/delete changes are now recorded in the Audit Log' },
    ],
  },
  {
    version: '1.288.0',
    date: '2026-08-23',
    highlights: [
      { category: 'security', text: 'Security hardening: tightened team-scoping on the MCP server, a few Manager-group History dashboard routes, and two admin listing endpoints so results are always limited to the caller\'s own accessible teams' },
      { category: 'security', text: 'Self-issuing an MCP read API key now requires a Leader/Admin role — no functional change for existing keys' },
    ],
  },
  {
    version: '1.287.0',
    date: '2026-08-22',
    highlights: [
      { category: 'feature', text: 'Nudge messages can now include a {days_since_activity} token showing how long it\'s been since the contributor last logged anything' },
      { category: 'improvement', text: 'The weekly-view nudge card now has two separate actions: Snooze (pick 1/7/30 days, same picker as the notification bell) and Close out (permanently dismiss — this rule never fires again for you, distinct from a time-boxed snooze)' },
    ],
  },
  {
    version: '1.286.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Fixed Project Primary Engineer showing a raw Salesforce User Id instead of a name — a field mapped to a Salesforce Lookup(User) is now automatically resolved against the local user cache, using the reference-type metadata SF Field Mappings already captures (no new checkbox or config needed)' },
    ],
  },
  {
    version: '1.285.0',
    date: '2026-08-22',
    highlights: [
      { category: 'feature', text: 'Project (Evaluation) preview popover can now show Primary Engineer, via a new eval_primary_engineer field mapping under Admin → SF Field Mappings — refreshed nightly and on hover, same as the other Project fields' },
      { category: 'fix', text: 'Fixed two Role Management seed migrations (Subtype Breakdown, Won w/o POC dashboard tabs) that were never actually applied because they were missing from the migration journal' },
    ],
  },
  {
    version: '1.284.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'Nudge Rules admin: Trigger Type and Trigger Config are now editable on an existing rule (previously only settable at creation) — changing the trigger type resets its config to that trigger\'s default shape, same as the Add Rule form' },
    ],
  },
  {
    version: '1.283.0',
    date: '2026-08-22',
    highlights: [
      { category: 'feature', text: 'Admin → Scheduling: every background job now has a "Run now" button to force an immediate run for testing, instead of waiting for its next scheduled tick (excludes Historical Import, which already has its own dedicated trigger)' },
    ],
  },
  {
    version: '1.282.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'Opportunity preview popover and nightly snapshot refresh now also fall back to the standard Assigned_SE__c / Primary_Engineer__c fields when the admin-configured field mapping resolves to nothing, so Assigned SE keeps showing up even if that mapping still points at the wrong field shape' },
    ],
  },
  {
    version: '1.281.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Weekly capacity legend no longer wraps to a second row as the window resizes — it stays on one line and shows "+N more" for whatever doesn\'t fit, sized dynamically to the available width instead of a fixed count' },
    ],
  },
  {
    version: '1.280.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Fixed SE Credit showing a raw ImpactIQ user id instead of the person\'s name for anyone credited through a name-valued Assigned SE field — a leftover gap from yesterday\'s name-matching fix' },
      { category: 'improvement', text: 'Coverage by rep pipeline and SE Credit (Attach Rate) can now expand/collapse each Team / Sub-team row, instead of always showing every user underneath' },
    ],
  },
  {
    version: '1.279.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Fixed the Opportunity preview popover (and the nightly snapshot refresh behind it) not showing Assigned SE / Primary Engineer at all when a team maps that field to a flat text/picklist field instead of a Salesforce User lookup — both now resolve whichever shape is actually configured' },
      { category: 'improvement', text: 'The Assigned Oppty SE field on the activity edit/create drawer now shows the same red "not an ImpactIQ user" flag used on the dashboards, both for the currently saved value and while picking a new one' },
      { category: 'improvement', text: 'Activity Type pill on logged activity cards now shows the activity\'s Subtype (e.g. "RFP") as a hover tooltip when one is set' },
      { category: 'improvement', text: 'Weekly capacity legend (Activities page) now shows every activity type represented that week instead of capping at 4 with a "+N more", wrapping naturally as the window resizes; each entry\'s color swatch is now that type\'s own icon instead of a plain square' },
    ],
  },
  {
    version: '1.278.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Fixed a real bug in yesterday\'s "not an ImpactIQ user" red-text flag: when Assigned SE / Supporting Engineers / etc. is configured as a literal-text picklist rather than a Salesforce User lookup, a credited person\'s name was never checked against the ImpactIQ roster at all — it was always shown in red, even for someone with a fully linked account. Both "Attached by SE" and SE Credit now resolve a name-valued credit against the team roster the same way the SF-ID path already did.' },
    ],
  },
  {
    version: '1.277.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'Attach Rate + the SF record preview popover on Activities cards now flag a credited SE / Assigned SE / Primary Engineer in red when they have no matching ImpactIQ account, so a name like a departed Salesforce user or someone outside your org stands out from your own team' },
      { category: 'improvement', text: 'SE Credit\'s empty state now explains why it can be blank even when "Attached by SE" shows names — it only counts credit to ImpactIQ users, and the credited Salesforce people may not have accounts here' },
      { category: 'fix', text: 'Fixed a leftover bug from the previous Attach Rate change: selecting a Team member/Subteam was hiding every OTHER SE\'s credit from the "by SE" breakdown instead of showing everyone covering that rep\'s book' },
    ],
  },
  {
    version: '1.276.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'Attach Rate: selecting a Team member or Subteam now recomputes the whole attach rate (headline %, trend, and both breakdown tables), scoped to the reps that person is aligned to cover — previously the selection only narrowed the "by SE" breakdown card while the headline rate kept counting the entire team' },
      { category: 'feature', text: 'Every grouped dropdown (Subtype, Sales Stage\'s Legacy Stages, and any other grouped filter) now has a "select all" checkbox on the group header itself, instead of only being able to check items one at a time' },
    ],
  },
  {
    version: '1.275.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'The "no admin Salesforce connection" refresh error now points at something the reader can actually do: an App Admin sees "Go to Admin -> Integrations to connect one," while anyone else sees "Contact your App Admin" instead of the previous one-size-fits-all wording' },
    ],
  },
  {
    version: '1.274.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Full audit of Sales Stage / Forecast / Products / ACV Range / Team-member filters across every dashboard — fixed several that silently ignored one or more: Opportunity ROI and Cost per ACV (missing Stage/Forecast/Products), Most Expensive (missing Products and Team-member/Subteam scoping), and Attach Rate + its SE-Credit/Rep-Coverage breakdown (missing Products, and the breakdown table ignored Team-member/Subteam selection entirely)' },
    ],
  },
  {
    version: '1.273.0',
    date: '2026-08-22',
    highlights: [
      { category: 'improvement', text: 'The "Refresh from Salesforce" button now shows a live countdown and is throttled to once per 30 minutes per user (was 10) to avoid hammering Salesforce' },
      { category: 'improvement', text: 'Admin -> Monitoring -> Scheduling\'s Recent Runs now shows a Source column ("Refresh Button" vs "Scheduled") for the Opp snapshot refresh job, so a manual click is distinguishable from the job\'s own 24h cadence' },
    ],
  },
  {
    version: '1.272.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Sales Stage / Forecast Category filters now actually apply on the Account and Opportunity Burn dashboard, and on the renamed Account / Opportunity Concentration dashboard — previously both silently ignored them (Most Expensive was the only Accounts-group dashboard that had them wired up)' },
      { category: 'improvement', text: 'Account / Opportunity Concentration (formerly Account Concentration) now measures real Accounts: activity on an Account\'s Opportunities and converted Leads rolls up into that Account instead of showing as its own separate bar, so the count of "accounts" per contributor is no longer inflated. Click a bar to see the Opportunities/Leads making it up' },
      { category: 'improvement', text: 'Scheduling: added a small Activity Types legend (color + icon) above the weekly calendar grid, matching the legend style already used on Activity SubType Breakdown' },
    ],
  },
  {
    version: '1.271.0',
    date: '2026-08-22',
    highlights: [
      { category: 'fix', text: 'Fixed "Refresh Sales Stage / Forecast from Salesforce" appearing to do nothing on failure: the server route always answered success even when the refresh could not run at all (e.g. no admin Salesforce connection configured), so a failed refresh looked identical to a successful no-op one — it now reports the failure and the button shows it' },
    ],
  },
  {
    version: '1.270.1',
    date: '2026-08-21',
    highlights: [
      { category: 'fix', text: 'Fixed the Account/Opportunity match popover on suggested-activity cards getting cut off (with no way to reach its bottom entries) when the card sat near the bottom of the Activities list' },
    ],
  },
  {
    version: '1.270.0',
    date: '2026-08-21',
    highlights: [
      { category: 'improvement', text: 'Activity SubType Breakdown now shows a color/icon legend of the Activity Types represented, right below the "What changed" panel' },
      { category: 'improvement', text: 'The Subtype filter dropdown (used across every dashboard) now shows each Activity Type\'s own icon, in its own color, next to its group header' },
      { category: 'improvement', text: 'Logging an activity: the Salesforce Link search now has a "Show Closed" checkbox (off by default) so you can attach an activity to a Closed Won/Lost Opportunity — previously there was no way to link to one at all' },
    ],
  },
  {
    version: '1.269.0',
    date: '2026-08-21',
    highlights: [
      { category: 'improvement', text: 'Activity SubType Breakdown now only lists actual Subtypes, dropping the "whole Activity Type" rows for types that have none logged — each row shows count/hours vs. its own Activity Type\'s total, plus its share of the page total' },
    ],
  },
  {
    version: '1.268.0',
    date: '2026-08-21',
    highlights: [
      { category: 'feature', text: 'New dashboard: Won w/o POC (Manager group) — Closed-Won Opportunities with ImpactIQ activity logged but no linked Evaluation (POC) record in Salesforce. Uses a live Salesforce read, so it needs your own Salesforce connection and a team that has an Activity Type configured with a related-object picker for the Evaluation object' },
      { category: 'improvement', text: 'Rows are grouped Subteam → User → Opportunity, with ACV and a count per Activity Type' },
    ],
  },
  {
    version: '1.267.0',
    date: '2026-08-21',
    highlights: [
      { category: 'improvement', text: 'Activity Type Breakdown: the Subtype expand chevron now also works on each contributor\'s own card, not just the Team Total row' },
      { category: 'feature', text: 'New dashboard: Activity SubType Breakdown (Activity group) — the same Team Total / per-contributor breakdown as Activity Type Breakdown, but with Subtype as the primary row instead of Activity Type; every bar keeps its parent type\'s color and icon' },
      { category: 'fix', text: 'Fixed Contributor Activity Mix bar colors changing when filtering by Subtype — colors are now tied to the Activity Type (matching Activity Type Breakdown) instead of shifting with whichever types happen to be present' },
      { category: 'improvement', text: 'Team Activity Deep-Dive: added the Subtype filter chip, plus a Subtype-level expand chevron on each Team Member row' },
      { category: 'improvement', text: 'User Leaderboard: added a Main Subteam column next to Team' },
    ],
  },
  {
    version: '1.266.0',
    date: '2026-08-21',
    highlights: [
      { category: 'fix', text: 'Fixed dashboard filter dropdowns (Subteams, Team member, Products, Sales Stage, Forecast, ACV Range) being clipped behind the sidebar when opened near the left edge of the filter row — they now render above everything else, like every other dropdown in the app' },
      { category: 'improvement', text: 'Activity Type Breakdown: types with admin-configured Subtypes now have an expand chevron showing the Subtype-level hours/count split under that type' },
      { category: 'improvement', text: 'Activity Mix: hovering a segment now also shows its Subtype breakdown when the team has any configured' },
      { category: 'feature', text: 'New Subtype filter chip on Activity Type Breakdown and Activity Mix — only appears for teams that have turned Subtypes on' },
    ],
  },
  {
    version: '1.265.0',
    date: '2026-08-21',
    highlights: [
      { category: 'improvement', text: "Dashboard's Subteam filter is now a true multi-select with checkboxes, matching Scheduling — pick several subteams and/or several individual people at once instead of just one of each. Unlike Scheduling it still starts at \"All\" rather than defaulting to your own subteam, since this is reporting, not a personal calendar view" },
      { category: 'fix', text: 'Fixed the Subteam / Team member filters not actually narrowing most dashboards below them — every leader dashboard (Heatmap, Breakdown, Mix, Capacity Trend, This Week, Plan vs Actual, Compliance, Lag, Concentration, WoW Delta, Products, Opp ROI, Cost per ACV, Team-of-Teams Rollup, Sales Team Breakdown, User Leaderboard, Project Costing, Attach Rate, Team Activity Deep-Dive) now consistently reads the selected people' },
      { category: 'improvement', text: 'Team Activity Deep-Dive keeps its own subteam/member selection independent — picking a subteam narrows the tree to that branch, and picking a person narrows further, rather than unioning like the other dashboards' },
    ],
  },
  {
    version: '1.264.0',
    date: '2026-08-21',
    highlights: [
      { category: 'fix', text: 'Fixed a bug where a subteam member appearing under two roles (e.g. member + leader) was listed twice in the Scheduling subteam filter' },
      { category: 'fix', text: 'Fixed the Scheduling subteam filter not actually narrowing the calendar once a specific member was picked — picking a person now un-checks the whole-subteam box instead of leaving it in the mix' },
      { category: 'improvement', text: 'The Subteam filter used across the leader Dashboard now shares the same expandable member-picker as Scheduling, so picking a specific person no longer requires a second dropdown' },
    ],
  },
  {
    version: '1.263.0',
    date: '2026-08-21',
    highlights: [
      { category: 'improvement', text: 'CRM Sync: clicking Resolve now updates the KPI header and Issues tab badge immediately, instead of waiting for a tab switch' },
      { category: 'improvement', text: 'Scheduling: a private/confidential meeting on the grid now shows a lock icon and never reveals its subject to anyone but its own owner, even to a leader' },
      { category: 'improvement', text: 'Scheduling: tentative meetings now show the same striped hatch pattern used on Activities cards' },
      { category: 'improvement', text: 'Scheduling: the Subteams filter defaults to your own subteam(s), and each subteam row has an expand chevron to pick individual members' },
      { category: 'feature', text: 'My Settings: new default Team / default Subteam pickers in Work & Notifications' },
    ],
  },
  {
    version: '1.262.1',
    date: '2026-08-20',
    highlights: [
      { category: 'improvement', text: 'Private Meetings: the transparent lock watermark on cards is now larger and easier to notice' },
    ],
  },
  {
    version: '1.262.0',
    date: '2026-08-20',
    highlights: [
      { category: 'feature', text: 'Private Meetings: meetings marked Private/Confidential in Outlook now show as "Private meeting" with a lock icon and pill everywhere in ImpactIQ, instead of the real subject' },
      { category: 'feature', text: 'New My Settings toggle "Private meetings → Non-Activity" (on by default) auto-excludes private meetings from your list, independent of keyword rules' },
      { category: 'improvement', text: 'Private meeting cards use the team\'s Non-Activity color (or plain light gray) as their background, with a large transparent lock watermark' },
    ],
  },
  {
    version: '1.261.0',
    date: '2026-08-20',
    highlights: [
      { category: 'feature', text: 'CRM Sync Issues: new Resolve button marks a failed sync as manually handled without retrying — reopens automatically if it fails again' },
      { category: 'improvement', text: 'CRM Sync KPI renamed to "Open/Resolved Issues", showing both counts as {{open}}/{{resolved}}' },
      { category: 'improvement', text: 'CRM Sync Issues: Open/Resolved/All status filter, with resolved rows shown de-emphasized alongside who resolved them and when' },
    ],
  },
  {
    version: '1.260.0',
    date: '2026-08-20',
    highlights: [
      { category: 'improvement', text: 'CRM Sync → Issues now also shows note pushes that are currently failing, not just activity writeback — with a Retry button, same as before' },
      { category: 'improvement', text: 'My Notes: success and failure pills now reflect only the latest push attempt per target, and the success pill shows the push date/time on hover' },
      { category: 'improvement', text: 'My Notes: "Also post this to Engineer Notes" checkbox is now available here too, not just the activity Notes tab' },
      { category: 'improvement', text: 'Note pushes to Salesforce now title the record "ImpactIQ: {Activity Type} - {Activity Title}" so it\'s obvious in Salesforce where it came from' },
    ],
  },
  {
    version: '1.259.1',
    date: '2026-08-20',
    highlights: [
      { category: 'fix', text: 'Fixed a race condition in note pushes to Salesforce that could intermittently fail with "ContentDocument lookup failed" right after a successful create — likely cause of some "Push failed" chips in My Notes' },
      { category: 'improvement', text: 'Engineer Notes checkbox on the Notes tab now shows for any activity with a linked Project, not just the "Eval Work" type by name' },
    ],
  },
  {
    version: '1.259.0',
    date: '2026-08-20',
    highlights: [
      { category: 'improvement', text: 'CRM Sync → History now captures every Salesforce write in the app, not just the activity writeback worker — note pushes, the Engineer Notes prepend-update, Assigned SE writes, and Opportunity/Evaluation field edits all show up with success/failure and the full JSON payload' },
      { category: 'improvement', text: 'New Source column + filter on CRM Sync → History so you can see which subsystem made each write' },
      { category: 'improvement', text: 'My Notes: hovering a "Push failed" chip now shows the actual Salesforce error instead of just "failed"' },
    ],
  },
  {
    version: '1.258.0',
    date: '2026-08-20',
    highlights: [
      { category: 'feature', text: 'New Admin → Monitoring → Activity Health page: a triage queue for the "Why Meeting?" reasons contributors capture on the Log Activity form' },
      { category: 'improvement', text: 'App Admins can mark each captured reason Ignore, Will Watch, or Addressed, with who reviewed it and when' },
    ],
  },
  {
    version: '1.257.0',
    date: '2026-08-20',
    highlights: [
      { category: 'fix', text: 'My History page now has the same 24px edge padding as every other page (Settings, My Notes, Guide)' },
      { category: 'improvement', text: 'User Leaderboard: the Top 10 chart can now rank by Total ACV, Closed ACV, Net Deal Margin, or Efficiency Ratio instead of always Total ACV' },
      { category: 'fix', text: 'Fixed: dismissing a nudge from the Weekly-view banner didn’t update the notification bell until its next poll, so the two could briefly disagree' },
      { category: 'improvement', text: 'Log Activity form: choosing "Meeting" now shows an optional "Why Meeting?" field, so we can learn whether recurring reasons point at a need for a more specific activity type' },
    ],
  },
  {
    version: '1.256.1',
    date: '2026-08-19',
    highlights: [
      { category: 'security', text: 'Security hardening: the Okta and Azure SSO login cookies (PKCE verifier + OIDC nonce) are now AES-256-GCM encrypted, closing a CodeQL clear-text-storage alert' },
    ],
  },
  {
    version: '1.256.0',
    date: '2026-08-18',
    highlights: [
      { category: 'feature', text: 'Log Activity form: new Subtype picker next to Activity Type — dynamic per type, ImpactIQ-only (never synced to Salesforce), hidden entirely when the chosen type has no Subtypes or the team hasn\'t turned the feature on' },
      { category: 'improvement', text: 'Activity Templates (My Settings and the quick "+ template" button on Activities) can now pre-fill a Subtype the same way' },
      { category: 'improvement', text: 'Admin → Activity Types: new "Enable Subtypes" checkbox next to Seed Default Content controls the picker for the whole team' },
    ],
  },
  {
    version: '1.255.5',
    date: '2026-08-18',
    highlights: [
      { category: 'fix', text: 'Guide Distinctions Markdown paragraph/list spacing actually renders now — the prior fix used Tailwind utilities that a plain CSS rule was silently overriding' },
      { category: 'improvement', text: '"Seed Default Content" moved to sit next to Add Activity Type instead of inside the Distinctions card, since it fills in the type list\'s own fields too' },
    ],
  },
  {
    version: '1.255.4',
    date: '2026-08-18',
    highlights: [
      { category: 'fix', text: 'Guide page: fixed 24px edge padding that was missing on both sides — the page body now uses the same header/content wrapper as Settings and My Notes' },
      { category: 'fix', text: 'Guide Distinctions and its admin Preview now put real visual space between paragraphs, lists, and headings, not just between manually broken lines' },
      { category: 'improvement', text: 'Admin → Activity Types: new "Seed Default Content" button fills in blank Classify Activity fields and Subtypes for the currently selected team directly — for the case where a migration\'s hardcoded team match silently found no matching team and skipped seeding' },
    ],
  },
  {
    version: '1.255.3',
    date: '2026-08-17',
    highlights: [
      { category: 'improvement', text: 'Guide Distinctions now renders full Markdown, including single line breaks — previously a line typed on its own without a blank line above/below got merged into the same paragraph as its neighbors, per standard Markdown rules' },
      { category: 'fix', text: 'Same fix applied to the admin Preview toggle, so what you see there now matches what renders on the Guide page' },
    ],
  },
  {
    version: '1.255.2',
    date: '2026-08-17',
    highlights: [
      { category: 'fix', text: 'Guide page: fixed a spacing gap that wasn\'t rendering between the activity-type cards and the Distinctions section' },
      { category: 'fix', text: 'Admin → Activity Types: Classify Activity placeholders no longer echo the real seeded copy, so it\'s obvious at a glance whether a field is actually filled in' },
      { category: 'feature', text: 'Admin → App Health: new Database Migrations status (applied/pending count, last-applied time) with a one-click "Run Pending Migrations" button — runMigrations() already runs on every server boot, but a long-running dev process needs this to pick up a newly-added migration without a restart' },
    ],
  },
  {
    version: '1.255.1',
    date: '2026-08-17',
    highlights: [
      { category: 'improvement', text: 'Guide page: 24px card gutters, and the Distinctions section now renders Markdown' },
      { category: 'improvement', text: 'Admin → Activity Types: Guide Distinctions editor gets a Preview toggle to see the rendered Markdown before saving' },
      { category: 'improvement', text: 'Guide moved in the sidebar to sit between My Settings and Admin; added as a Flight Deck "Common pages" choice' },
      { category: 'improvement', text: 'Seeded Subtype labels (e.g. Discovery → Technical Discovery, Architecture Discovery) for the Sales Engineering team\'s 9 non-Meeting activity types' },
    ],
  },
  {
    version: '1.255.0',
    date: '2026-08-17',
    highlights: [
      { category: 'feature', text: 'New Guide page in the sidebar (all roles) — when to use each activity type, what it usually attaches to in Salesforce, and worked examples, plus a Distinctions section (e.g. Discovery vs Demo)' },
      { category: 'feature', text: 'Admin → Activity Types: new "Classify Activity" section feeds the Guide page, plus an optional Subtypes list per type (display-only for now) and a team-wide "Guide: Distinctions" editor' },
      { category: 'improvement', text: 'Seeded with the Sales Engineering team\'s 9 non-Meeting activity types out of the box' },
    ],
  },
  {
    version: '1.254.3',
    date: '2026-08-13',
    highlights: [
      { category: 'improvement', text: 'Activity drawer tabs now lead with an icon (Edit, Notes, Sync History), matching every other pill/badge/button in the app' },
      { category: 'improvement', text: 'Sync History tab now shows its own record count next to the name, just like Notes' },
    ],
  },
  {
    version: '1.254.2',
    date: '2026-08-13',
    highlights: [
      { category: 'feature', text: 'New Notes tab on the activity drawer (once an activity exists), with a live count next to the tab name — same By Activity/Opportunity/Account/Campaign/Lead view as the notes icon on the card, so notes are reachable from either place' },
      { category: 'improvement', text: 'The Eval Work-only "Also post this to Engineer Notes" checkbox now lives with the note draft in both places (the card\'s Notes drawer and the new tab) — the standalone Notes field + checkbox that used to sit inline in the activity form is gone, since the tab replaces it' },
    ],
  },
  {
    version: '1.254.1',
    date: '2026-08-13',
    highlights: [
      { category: 'fix', text: 'Fixed: the "Also post this to Engineer Notes" checkbox only rendered while creating a brand-new activity — invisible on every edit, which is when most Eval Work activities actually get their Project link added or confirmed. Notes + the checkbox now stay visible on edit too whenever a Project is linked' },
    ],
  },
  {
    version: '1.254.0',
    date: '2026-08-13',
    highlights: [
      { category: 'feature', text: 'New "post a dated update" mode for two Salesforce Project fields — Engineer Notes (via a checkbox next to Notes) and Situation / Next Steps (a new blank field in the Project panel, with an info icon to view the full current text) — every entry is prepended above existing history with your initials and today\'s date, nothing existing is ever overwritten' },
      { category: 'improvement', text: 'Live character-capacity preview reads Salesforce\'s real field length and blocks submission before it would overflow the field' },
      { category: 'improvement', text: 'Map the two new fields (eval_engineer_notes / eval_next_steps) to your org\'s real Salesforce API names in Admin → SF Field Mappings' },
    ],
  },
  {
    version: '1.253.1',
    date: '2026-08-13',
    highlights: [
      { category: 'improvement', text: 'Show Non-Activities now also applies to the Outlook Calendar panel — turning it off hides Non-Activity meetings there too, not just in the activity list' },
      { category: 'fix', text: 'Fixed the weekly hours pill\'s hover text to read "Total Activity Hours Approved This Week" instead of "Total hours logged this week", in all 7 languages' },
    ],
  },
  {
    version: '1.253.0',
    date: '2026-08-13',
    highlights: [
      { category: 'improvement', text: 'The linked Evaluation panel in the activity edit drawer now notes that field edits update immediately in Salesforce' },
      { category: 'improvement', text: 'The On-site pin on an activity card turns orange and shows the incidental cost total (in your currency) on hover whenever Direct Costs were entered for that activity' },
      { category: 'feature', text: 'Added an orange "Onsite Incidental" pill next to the weekly ACV pill, totaling the week\'s onsite incidental costs the same way the ACV pill totals Opportunity value' },
    ],
  },
  {
    version: '1.252.0',
    date: '2026-08-13',
    highlights: [
      { category: 'improvement', text: 'Flight Deck checklist items now have an expand icon (a picture icon when screenshots are attached, an info icon otherwise) that reveals the full tooltip text and any screenshots — the tooltip is still always available on hover' },
      { category: 'improvement', text: 'Added a Flight Deck button to the header bar, between the days-left pill and the language picker, so you can reopen the checklist any time it\'s turned on' },
    ],
  },
  {
    version: '1.251.1',
    date: '2026-08-12',
    highlights: [
      { category: 'improvement', text: 'Flight Deck modal now shows the team’s theme logo (120×35px, light/dark aware) in the top-right corner, matching every other page’s header; removed the X close button — "Let’s Get to Work" and clicking outside the modal are the only ways to dismiss it' },
      { category: 'improvement', text: 'Added a blue bell-ring icon next to "Notifications" in the notification bell popover header' },
    ],
  },
  {
    version: '1.251.0',
    date: '2026-08-12',
    highlights: [
      { category: 'fix', text: 'Fixed: teams that already had a custom Flight Deck item never received the 4 seeded default items, since the original backfill only ran for teams with zero items — a new migration backfills by checking each default individually, and Admin → Flight Deck now has an "Add Default Items" button to fix this on demand for any team, anytime' },
      { category: 'improvement', text: 'Added a 5th default checklist item: "Connect your Outlook account"' },
    ],
  },
  {
    version: '1.250.2',
    date: '2026-08-12',
    highlights: [
      { category: 'improvement', text: 'Flight Deck: each checklist item now has an explicit link button on the right (with a hover tooltip) as the only click target for navigation — clicking the label/icon area itself no longer silently jumps you elsewhere' },
      { category: 'improvement', text: 'Flight Deck: items with screenshots now show a picture-icon button that expands/collapses the thumbnail row in place, instead of always showing thumbnails under every item' },
    ],
  },
  {
    version: '1.250.1',
    date: '2026-08-12',
    highlights: [
      { category: 'fix', text: 'Fixed a blank-screen crash on Admin → Flight Deck for any item whose screenshots value came back as null instead of an empty list (every row that predates the screenshots column) — normalized server-side and guarded client-side' },
    ],
  },
  {
    version: '1.250.0',
    date: '2026-08-12',
    highlights: [
      { category: 'fix', text: 'Flight Deck fixes: the icon picker no longer pushes the page sideways when opened, "Common pages" now matches the real sidebar (including Scheduling) and uses the correct "Activities" name, and existing teams now get the 4 seeded checklist items retroactively' },
      { category: 'improvement', text: 'Flight Deck: up to 10 items can be active at once, but you can now add as many as you want — new/reactivated items beyond 10 land inactive with a heads-up instead of being blocked' },
      { category: 'improvement', text: 'Flight Deck: added an icon color picker, up to 5 screenshots per checklist item (click a thumbnail to expand), and a Preview button that shows the exact welcome modal a contributor will see' },
      { category: 'improvement', text: 'Icon picker (used app-wide — Nudge Rules, Activity Types, Teams, Templates, Flight Deck): now searches the full lucide icon library instead of a ~90-icon shortlist' },
    ],
  },
  {
    version: '1.249.0',
    date: '2026-08-12',
    highlights: [
      { category: 'feature', text: 'New: Flight Deck, a team-configurable onboarding checklist shown in a welcome modal after login — check off items, click through to app pages or external links, and dismiss with "Don’t show again"' },
      { category: 'improvement', text: 'Admin → Workplace → Flight Deck: add/reorder/edit checklist items (drag to reorder, icon picker, App Page or External URL links), plus per-language label/tooltip translations' },
      { category: 'improvement', text: 'My Settings → Preferences: a new toggle to re-enable the Flight Deck modal after dismissing it' },
    ],
  },
  {
    version: '1.248.0',
    date: '2026-08-11',
    highlights: [
      { category: 'fix', text: 'Fixed several dashboard translation gaps: Account/Opportunity Burn pills now translate the Campaign/Lead badge instead of showing the raw key, and activity counts are properly pluralized in every language' },
      { category: 'fix', text: 'Product Breakdown was entirely untranslated outside English — its title, empty state, and column headers now have real translations in all 6 other locales' },
      { category: 'fix', text: 'The "When activities are entered" heatmap on Logging Compliance now localizes its month names, weekday headers, and entry-count tooltips instead of always rendering in English' },
      { category: 'fix', text: 'Plan vs. Actual bar tooltips and the Activities page month heatmap’s "Fiscal period" label are now translated, and month names throughout use the interface language instead of always English' },
    ],
  },
  {
    version: '1.247.0',
    date: '2026-08-11',
    highlights: [
      { category: 'fix', text: 'Fixed the two-factor setup title wrapping to two lines by widening the dialog' },
      { category: 'fix', text: 'Fixed a missing translation key on the backup-codes download button and added a matching leading icon + Title Case heading to the Save Your Backup Codes screen' },
    ],
  },
  {
    version: '1.246.0',
    date: '2026-08-10',
    highlights: [
      { category: 'improvement', text: 'Team Activity Deep-Dive: added a Total Hours column (sum of logged hours) between Total Count and AVG Duration' },
      { category: 'fix', text: 'Fixed: the Outlook calendar month heatmap on the Activities page didn\u2019t update after approving, unapproving, deleting, or syncing an activity \u2014 it only refreshed on page reload, month paging, or switching team/user' },
      { category: 'fix', text: 'Fixed: the attendee filter\u2019s "Showing all" tooltip on the Activities page incorrectly said "unapproved meetings" instead of describing what the filter actually toggles (Required vs. Optional)' },
      { category: 'security', text: 'Patched a high-severity Dependabot alert in a build-time dependency (nanoid, via postcss) \u2014 build/dev tooling only, never shipped to the browser or server bundle' },
    ],
  },
  {
    version: '1.245.0',
    date: '2026-08-10',
    highlights: [
      { category: 'feature', text: 'New Manager dashboard: Team Activity Deep-Dive \u2014 a collapsible Activity Type \u2192 Subteam \u2192 Team Member tree with Total Count, AVG Duration, Total ACV Connected To, AVG Count Per Oppty, and AVG Per Week/Month/Quarter/Year, single-team scoped and fully wired to the Subteam / Team member / Products / Stage / Forecast / ACV filters' },
      { category: 'fix', text: 'Fixed: the Subteam, Team member, Products, Stage, Forecast, and ACV Range filters had no effect on Team-of-Teams Rollup, Sales Team Breakdown, and User Leaderboard \u2014 the chips rendered but silently changed nothing' },
      { category: 'security', text: 'Fixed: a Team Leader granted the global "can see all teams" flag got full cross-team visibility on Admin screens but not on Team-of-Teams Rollup, Most Expensive, or User Leaderboard; those three dashboards were also reachable directly by any signed-in Contributor regardless of role' },
    ],
  },
  {
    version: '1.244.0',
    date: '2026-08-07',
    highlights: [
      { category: 'fix', text: 'Fixed: approving an activity now stamps the ImpactIQ category on the linked Outlook meeting even when someone else organized it \u2014 previously only meetings ImpactIQ created itself got categorized' },
      { category: 'improvement', text: 'Your existing Outlook categories on that meeting are preserved; ImpactIQ is added alongside them, never replacing them' },
      { category: 'improvement', text: 'Refreshed CLAUDE.md, README.md and PRD.md to match what has actually shipped' },
    ],
  },
  {
    version: '1.243.0',
    date: '2026-08-07',
    highlights: [
      { category: 'feature', text: 'My Settings \u2192 Data & Templates has a new My Non-Activity Keywords field: enter comma-separated subject text and matching meetings are auto-marked Non-Activity in your ImpactIQ only' },
      { category: 'improvement', text: 'Runs after your team\u2019s Keyword Rules (so a team rule assigning a real activity type still wins) and before the AI classifier' },
      { category: 'improvement', text: 'Cards marked this way read "Your keyword" and link to your own settings, rather than to an admin page you may not have access to' },
    ],
  },
  {
    version: '1.242.0',
    date: '2026-08-07',
    highlights: [
      { category: 'feature', text: 'Approved activities whose Outlook meeting has been deleted are now surfaced for review: a "This Week\u2019s Deleted Activities (Approved)" section above the week, plus a bell and header notification counting every week' },
      { category: 'improvement', text: 'Keep leaves an activity in ImpactIQ + Salesforce (marked "Not In Outlook", with a grey right edge on the calendar); Delete removes it from ImpactIQ and Salesforce permanently, with a confirmation and an audit record' },
      { category: 'fix', text: 'Fixed the tentative hatch never appearing on the Outlook calendar panel \u2014 the RSVP was stored but dropped when reading events back from the cache' },
      { category: 'fix', text: 'Fixed calendar weeks outside the sync window rendering empty on the right while the same meetings showed on the left' },
    ],
  },
  {
    version: '1.241.0',
    date: '2026-08-06',
    highlights: [
      { category: 'fix', text: 'Meetings that match no keyword rule now show a white "No Match" pill and stay in the list \u2014 they are no longer auto-hidden as Non-Activity, which was burying exactly the meetings that needed a decision' },
      { category: 'improvement', text: 'Admin \u2192 Keyword Rules explains up front what happens to a meeting no rule matches' },
      { category: 'improvement', text: 'Tentative meetings now carry a subtle diagonal hatch on the activity list, the Outlook calendar, and after approval \u2014 and it follows the RSVP if it changes later' },
      { category: 'improvement', text: 'Meeting responses in the Log Activity drawer now show Required / Optional per attendee, and the green approved check has an "Approved on \u2026" tooltip' },
    ],
  },
  {
    version: '1.240.0',
    date: '2026-08-06',
    highlights: [
      { category: 'improvement', text: 'The "nothing matched" suggestion fallback is now deterministic and admin-configurable — Admin → Activity Types can mark one type as the Default suggestion, instead of whichever type an unordered query happened to read first (usually Demo)' },
      { category: 'feature', text: 'Keyword Rules can now auto-flag matching meetings as Non-Activity instead of suggesting a type — same effect as clicking Non-Activity by hand, and just as reversible' },
      { category: 'improvement', text: 'Unapproved meeting cards now show when you are a Required or Optional attendee, plus a new All / Optional / Required filter pill next to the sort and expand buttons' },
    ],
  },
  {
    version: '1.239.0',
    date: '2026-08-05',
    highlights: [
      { category: 'improvement', text: 'Log Activity now shows a read-only "Meeting responses" summary (who accepted/declined/is tentative) when opened from an Outlook event or a suggested meeting — informational only, not saved with the activity' },
      { category: 'fix', text: 'Fixed the Outlook event details modal mislabeling 3 of the 6 real meeting-response states (tentativelyAccepted, notResponded, organizer showed as raw text) and added a leading icon to the response badge' },
    ],
  },
  {
    version: '1.238.0',
    date: '2026-08-05',
    highlights: [
      { category: 'fix', text: 'Fixed clicking a day in the mini month heatmap jumping to the wrong week in Sunday-first mode (some Sundays did nothing, Saturdays jumped back a week) — it now uses the same Sun/Mon week anchor as the rest of the page' },
    ],
  },
  {
    version: '1.237.0',
    date: '2026-08-05',
    highlights: [
      { category: 'fix', text: 'Fixed Sunday-first week display on Activities and Scheduling: it now shows a real Sun-Sat week (e.g. Aug 2-8) instead of moving next week\'s Sunday to the front of the same Mon-Sun range' },
      { category: 'improvement', text: 'Date range labels, prev/next tooltips, the mini month heatmap, and Scheduling\'s Free Time panel all follow the corrected week now' },
      { category: 'improvement', text: 'Removed the solid blue background from the Show Weekends and week-start toggle buttons on both pages' },
    ],
  },
  {
    version: '1.236.0',
    date: '2026-08-05',
    highlights: [
      { category: 'improvement', text: 'Activities page: the Sunday-first / Monday-first week toggle now also reorders the left-side day-by-day activity list, matching the Outlook Calendar panel on the right' },
      { category: 'feature', text: 'Scheduling page: added its own Show Weekends (single button) and Sunday-first/Monday-first week toggle, matching Activities' },
    ],
  },
  {
    version: '1.235.0',
    date: '2026-08-05',
    highlights: [
      { category: 'feature', text: 'Outlook Calendar panel: added a Sunday-first / Monday-first week display toggle (default Sunday-first), remembered per browser' },
      { category: 'improvement', text: 'Collapsed the "Show weekends" control from 2 buttons into 1, icon swapping with state to match the new toggle beside it' },
    ],
  },
  {
    version: '1.234.0',
    date: '2026-08-05',
    highlights: [
      { category: 'fix', text: 'Fixed the notification bell and bottom nudge toast showing nudges from every team regardless of which team is active in the sidebar — they now scope to the current team, matching the Weekly View banner (unaffected when "All Teams" is selected)' },
    ],
  },
  {
    version: '1.233.0',
    date: '2026-08-05',
    highlights: [
      { category: 'fix', text: 'Fixed the Outlook Calendar person switcher on Weekly View keeping the previous team\'s selected person (sometimes an invalid one, no longer in the new team) after switching teams in the sidebar — it now resets to "you" on a team switch' },
    ],
  },
  {
    version: '1.232.0',
    date: '2026-08-05',
    highlights: [
      { category: 'improvement', text: 'Slack moved from its own standalone admin page into Admin → Integrations, as a card matching Okta / Salesforce / Microsoft / Email — same setup, connect, sync, and disconnect flow, one less sidebar entry' },
    ],
  },
  {
    version: '1.231.0',
    date: '2026-08-05',
    highlights: [
      { category: 'improvement', text: 'Admin → Scheduling now names the exact Communications rule each job sends through — the regular-email rule under digest_worker/weekly_recap_worker, and the shared job-failure-alert rule next to every "Email admins on error" toggle' },
      { category: 'fix', text: 'Fixed the Scheduled job failure alert rule preview stuck on "Loading preview..." in Admin → Communications' },
    ],
  },
  {
    version: '1.230.0',
    date: '2026-08-05',
    highlights: [
      { category: 'improvement', text: 'Renamed the "Email Communications" admin section to "Communications" (nav + Role Management)' },
      { category: 'feature', text: 'Admin → Scheduling: digest_worker and weekly_recap_worker now let you edit the local send time (and day of week for the weekly recap), not just whether they run' },
      { category: 'improvement', text: '"Email admins on error" now sends through Admin → Communications as a templatable rule, using the default template until customized' },
      { category: 'improvement', text: 'Admin → Communications now shows which address regular (non-error) emails send from' },
    ],
  },
  {
    version: '1.229.0',
    date: '2026-08-05',
    highlights: [
      { category: 'fix', text: 'Fixed job_runs filling up fast: the Salesforce and Outlook write-back queue pollers and the notes push worker no longer log a row on every quiet 30-second tick — only when there was real work to report, matching how digest and weekly recap already behaved' },
    ],
  },
  {
    version: '1.228.0',
    date: '2026-08-04',
    highlights: [
      { category: 'fix', text: 'Fixed the Outlook Calendar person-switcher on Weekly View showing the previous team’s members after switching teams in the sidebar instead of refreshing to the newly-selected team' },
    ],
  },
  {
    version: '1.227.0',
    date: '2026-08-04',
    highlights: [
      { category: 'feature', text: 'Admin → Scheduling: every background job can now be turned on/off, and cadence is editable for the jobs where that’s meaningful (an "Active" column and a pencil-icon edit next to Cadence)' },
      { category: 'improvement', text: 'Every job now records a real run message instead of showing "—" — five jobs that never recorded a run before (writeback, notes push, digest, weekly recap, audit cull) now show up on the Scheduling page' },
    ],
  },
  {
    version: '1.226.0',
    date: '2026-08-04',
    highlights: [
      { category: 'improvement', text: 'Every Meeting Load figure now has an info button explaining what it measures, what it needs to appear, and whether it’s on for your team — visible even when it’s off' },
      { category: 'improvement', text: 'Team Heatmap and Capacity Trend now show Meeting Load alongside the other capacity signals, matching This-Week Capacity' },
      { category: 'fix', text: 'Fixed the "What changed" panel showing the wrong week-start date for anyone in a timezone behind UTC' },
    ],
  },
  {
    version: '1.225.0',
    date: '2026-08-04',
    highlights: [
      { category: 'feature', text: 'Leader dashboards can now show a "Meeting Load" figure alongside logged/target hours, correctly excluding declined, cancelled, and Free-marked calendar events (admin opt-in per capacity group)' },
      { category: 'feature', text: 'New Calendar-Derived capacity method: a group’s target hours can auto-compute from members’ own trailing meeting load instead of a flat number, with a floor fallback when there isn’t enough calendar history' },
    ],
  },
  {
    version: '1.224.0',
    date: '2026-08-04',
    highlights: [
      { category: 'fix', text: 'Fixed the Weekly View heat map jumping to the wrong month after paging to a different month and clicking a day there' },
    ],
  },
  {
    version: '1.223.0',
    date: '2026-08-04',
    highlights: [
      { category: 'improvement', text: 'CRM Historical Import: Recent Runs now shows only the last 10 runs, and Recent Runs / Top Event Creators both carry a leading icon' },
      { category: 'improvement', text: 'Excluding a Salesforce user (by Created By or Owner) now starts with a name/email search instead of requiring a raw Salesforce Id — picking a result fills in the label automatically' },
    ],
  },
  {
    version: '1.222.0',
    date: '2026-08-03',
    highlights: [
      { category: 'fix', text: 'The What changed info popover no longer closes when you scroll \u2014 it follows the button instead, so you can read past the fold' },
      { category: 'improvement', text: 'Project links on activity cards now show the same hover preview as Opportunity and Account: type, status, stage and start / end dates, with a past end date flagged' },
      { category: 'improvement', text: 'Admin \u2192 CRM Historical Import: the look-back window is configurable from 1 year up to 3 years, or set a specific earliest date \u2014 useful when your Salesforce data is only trustworthy after a migration or go-live' },
    ],
  },
  {
    version: '1.221.0',
    date: '2026-08-02',
    highlights: [
      { category: 'fix', text: 'Fixed spurious \u201crate limited\u201d errors: the limiter now counts per session instead of per IP address (everyone behind the same proxy was sharing one budget) and no longer counts static files like JavaScript and images' },
      { category: 'improvement', text: 'Raised the default request allowance to 600 per 5 minutes to match what the old number was always meant to mean' },
      { category: 'improvement', text: 'Added an info button to the What changed panel explaining all six checks, the comparison window, and what each severity colour means' },
    ],
  },
  {
    version: '1.220.0',
    date: '2026-08-02',
    highlights: [
      { category: 'feature', text: 'New What changed panel above every leader dashboard: spots account burn spikes, over-capacity contributors, people who stopped logging, activity-type swings, unlinked activities and Salesforce sync failures' },
      { category: 'improvement', text: 'Compares the last completed week against a fixed 8-week baseline, so switching the date filter doesn\u2019t change what counts as unusual' },
      { category: 'improvement', text: 'Tuned to stay quiet \u2014 every check has a volume floor as well as a ratio threshold, and the panel is capped at six items' },
    ],
  },
  {
    version: '1.219.0',
    date: '2026-08-02',
    highlights: [
      { category: 'feature', text: 'Admin \u2192 SF Field Mappings has a Validate & dry run panel: checks every mapping against your Salesforce org and previews the exact payload a sync would send, without writing anything' },
      { category: 'improvement', text: 'Catches the failures that never reach Sync Issues \u2014 a read-only mapping on Subject, a missing WhatId link, an activity type whose Type value isn\u2019t in the picklist' },
      { category: 'fix', text: 'Fixed refresh-only mappings on Event / Task being written back to Salesforce despite the flag' },
    ],
  },
  {
    version: '1.218.0',
    date: '2026-08-02',
    highlights: [
      { category: 'feature', text: 'Hover the Opportunity or Account name on an activity card for an inline Salesforce preview — stage, forecast, value, close date, owner and Assigned SE without leaving the weekly view' },
      { category: 'improvement', text: 'An overdue close date on a still-open opportunity is flagged in amber, and won / lost deals carry a badge' },
      { category: 'improvement', text: 'The preview works without a Salesforce connection by falling back to the last synced values, and says which it is showing' },
    ],
  },
  {
    version: '1.217.0',
    date: '2026-08-02',
    highlights: [
      { category: 'improvement', text: 'Dashboard presets now save the Subteam, Sales Stage, Forecast Category and ACV range filters — previously those four were silently dropped when the preset was applied' },
      { category: 'fix', text: 'Applying a preset no longer clears the team-member pick while the subteam roster is still loading' },
    ],
  },
  {
    version: '1.216.0',
    date: '2026-08-02',
    highlights: [
      { category: 'improvement', text: 'Sync Issues and Sync History are now one CRM Sync page, with health KPIs on top and both views a click apart' },
      { category: 'improvement', text: 'Historical Import moved to Integrations and renamed CRM Historical Import' },
      { category: 'improvement', text: 'Role Management now matches the app: same order as the sidebar, plus the 24 dashboard and admin pages that were missing from it' },
      { category: 'fix', text: 'Fixed several leader dashboards (Most Expensive, User Leaderboard, Opportunity ROI, Cost per ACV, Manager Rollup, Sales Team Breakdown, Products Breakdown) being hidden from leaders because their permissions were never seeded' },
    ],
  },
  {
    version: '1.215.0',
    date: '2026-08-01',
    highlights: [
      { category: 'feature', text: 'Historical import can now skip machine-generated Salesforce Events — seeded with Outreach and ClickToSchedule, which together account for a third of the events in the 3-year window' },
      { category: 'improvement', text: 'Exclusions apply by Salesforce creator or owner, and adding one reports how many already-imported events it matches before you delete them' },
      { category: 'improvement', text: 'The all-day event hour cap is now an admin setting instead of a fixed 8 hours' },
      { category: 'improvement', text: 'Recurring and all-day events are badged and filterable across My History and the History dashboard' },
    ],
  },
  {
    version: '1.214.0',
    date: '2026-08-01',
    highlights: [
      { category: 'feature', text: 'Import years of pre-ImpactIQ Salesforce activity: an admin-triggered, resumable backfill links historical Events to users, Opportunities, and Accounts' },
      { category: 'feature', text: 'New History dashboard and a personal My History page, plus a Historical Salesforce Activity section on every Account and Opportunity drill-in' },
      { category: 'improvement', text: 'Historical hours are estimates from Salesforce meeting length and are excluded from all cost and capacity reporting — labelled as such everywhere they appear' },
      { category: 'improvement', text: 'Open Opportunities in the historical mirror refresh nightly; closed ones freeze permanently' },
    ],
  },
  {
    version: '1.213.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Nightly Salesforce Opportunity/Evaluation snapshot refresh is now incremental (SystemModstamp watermark) instead of re-pulling every record every night, with bulk writes replacing per-record updates' },
      { category: 'improvement', text: 'Attach Rate coverage refresh (Assigned SE / Evaluation attach details) is incremental too, with an age-based cull replacing the old full-diff delete' },
    ],
  },
  {
    version: '1.212.1',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Admin sidebar: Monitoring & Audit no longer force-expands by default — only the category containing the active section stays open' },
    ],
  },
  {
    version: '1.212.0',
    date: '2026-07-31',
    highlights: [
      { category: 'feature', text: 'Failed Salesforce write-backs now retry automatically with exponential backoff (up to 6 attempts) before parking for manual retry' },
    ],
  },
  {
    version: '1.211.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Admin sidebar categories are now collapsible (Monitoring & Audit open by default); App Health leads the menu and opens by default' },
      { category: 'improvement', text: 'App Health "Tables by size" is now sortable and searchable per column' },
      { category: 'improvement', text: 'MCP Activity moved onto the MCP Server page (connection details collapse into one card; modern KPI cards)' },
    ],
  },
  {
    version: '1.210.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Retention: the housekeeping job now culls audit log, job-run history and attach-rate history to a 3-year window so they no longer grow forever' },
      { category: 'feature', text: 'Optional activities archival (off by default) can soft-archive activities older than a configurable cutoff' },
    ],
  },
  {
    version: '1.209.1',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'App Health: health-colored stat cards (green/amber/red), solid table backgrounds, and a legend explaining the amber missing-index flag — which now only flags sizeable tables, not small ones Postgres scans by design' },
    ],
  },
  {
    version: '1.209.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Performance: "All time" dashboard ranges are now capped to the retention window (~3 years) so they can no longer trigger an unbounded table scan as history grows' },
    ],
  },
  {
    version: '1.208.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Performance: added indexes to the activities table (previously unindexed) so dashboards use index seeks instead of full scans as data grows' },
      { category: 'improvement', text: 'ACV Impact tiles now filter to the fiscal window in SQL instead of scanning the whole opportunity snapshot; FX rates are cached per request' },
    ],
  },
  {
    version: '1.207.0',
    date: '2026-07-31',
    highlights: [
      { category: 'feature', text: 'New Admin → Monitoring → App Health page: live database size, per-table rows/size, sequential-vs-index scan flags, slowest queries (pg_stat_statements), connection headroom and app memory' },
      { category: 'improvement', text: 'Database client hardened with a connection pool cap, statement timeout, and an optional query logger; slow HTTP requests are now logged' },
    ],
  },
  {
    version: '1.206.1',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Weekly view: the month heatmap now renders at full height (no longer clipped); calendar defaults to 60% so the heatmap and data points both fit' },
    ],
  },
  {
    version: '1.206.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'ACV Impact tiles now honor your "Show Costs In" currency and use the modern KPI-card style' },
      { category: 'improvement', text: 'Weekly view right column defaults to a dynamic 70% calendar / 10% heatmap / 20% data-points split' },
    ],
  },
  {
    version: '1.205.0',
    date: '2026-07-31',
    highlights: [
      { category: 'feature', text: 'Weekly view: ACV Impact CFQ / CFY tiles — your running Total ACV across every opportunity you\'re attached to (Assigned SE or Evaluation engineer), deduplicated' },
      { category: 'improvement', text: 'Toggle the tiles between Close Date and Created Date; computed from the local Salesforce snapshot, no per-view SF call' },
    ],
  },
  {
    version: '1.204.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Sales Stage / Forecast filters read the full picklist from the current user\'s Salesforce connection (no more showing only the two values present in data)' },
      { category: 'security', text: 'User-facing Salesforce reads now always use the signed-in user\'s connection — the admin connection is reserved for Admin pages and background sync' },
    ],
  },
  {
    version: '1.203.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'Attach Rate ACV weighting and the ACV range filter now use Total_Acv__c (falling back to Amount until the next coverage refresh)' },
      { category: 'improvement', text: 'ACV range bucket labels show the selected "Show Costs In" currency symbol' },
    ],
  },
  {
    version: '1.202.0',
    date: '2026-07-31',
    highlights: [
      { category: 'improvement', text: 'ACV range filter now matches the ACV shown on dashboards (Total_Acv__c), and honors the "Show Costs In" currency' },
      { category: 'improvement', text: 'ACV range now applies to Account/Opp Burn, Account Concentration, Opportunity ROI, Cost of Engagement, Team-of-Teams Rollup, and Sales Team Breakdown' },
    ],
  },
  {
    version: '1.201.0',
    date: '2026-07-31',
    highlights: [
      { category: 'feature', text: 'New ACV range filter on Opportunity-scoped dashboards (Most Expensive, User Leaderboard, Project Costing, Attach Rate)' },
      { category: 'improvement', text: 'Slice by deal size with fixed buckets from <$5K to $500K+; non-opportunity activities are excluded while a range is applied' },
    ],
  },
  {
    version: '1.200.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Team Capacity Trend now accounts for PTO/holidays — the capacity marker drops on weeks the team is partly out, for an accurate target' },
      { category: 'improvement', text: 'This-Week Capacity now shows a company-holiday breakdown (indigo segment + hours) distinct from PTO' },
      { category: 'improvement', text: 'Activity Type Breakdown: removed the unused Pie Chart toggle, leaving the bar view' },
    ],
  },
  {
    version: '1.199.0',
    date: '2026-07-30',
    highlights: [
      { category: 'fix', text: 'Team Heatmap no longer mislabels company holidays as PTO — reduced-capacity cells now read "PTO" only for actual time off, "Hol" for holidays' },
      { category: 'improvement', text: 'This-Week Capacity shows each user\'s PTO hours and paints an amber PTO segment on the bar so the capacity reduction is visible' },
    ],
  },
  {
    version: '1.198.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Attach Rate now honors the FY/FQ and custom Start/End window — the cohort and weekly trend follow the selected fiscal period instead of the last N weeks' },
      { category: 'improvement', text: 'Missing-Assigned-SE card shows the top 5 opportunities by ACV; "View all" opens a slide-in drawer listing every one, each linking out to Salesforce to set the Assigned SE' },
    ],
  },
  {
    version: '1.197.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'My Settings → Connections now shows a "Reconnect needed" state on the Salesforce and Outlook cards when a stored token has been revoked or expired, instead of a misleading green "Connected"' },
      { category: 'improvement', text: 'Outlook status now probes the stored token so the calendar-connection health is accurate' },
      { category: 'fix', text: 'Admin Salesforce: the "token not working" banner now clears immediately after a successful Reconnect, without waiting for Test Connection' },
    ],
  },
  {
    version: '1.196.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Dashboard date windows (custom range + FY/FQ) now drive the Team Heatmap, Capacity Trend, Logging Compliance and Attach Rate columns/trend — no more recent-weeks data leaking into a selected fiscal period' },
      { category: 'improvement', text: 'Sales Stage filter leads with the current numbered stages; older values are tucked under a collapsible "Legacy Stages" group' },
      { category: 'fix', text: 'Fixed the Outlook calendar day-name header drifting out of column alignment with the grid when a scrollbar is present (most visible on PTO days); PTO marker now pins to the top of the day' },
    ],
  },
  {
    version: '1.195.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Dashboard filters: Compare and Range are now compact dropdowns to free up space' },
      { category: 'feature', text: 'New Date basis control (Date of Activity / Date Created / Close Date) sets what every dashboard\'s date window filters against — defaults to Date of Activity' },
      { category: 'feature', text: 'Added an FY / FQ quick-pick (previous / current / next fiscal year and quarters) that sets the Start/End window from the Admin Calendars fiscal config' },
      { category: 'improvement', text: 'Moved the Presets button to the far-right of the header row and fixed its popup being clipped' },
    ],
  },
  {
    version: '1.194.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Missing-Assigned-SE call-out now shows the opportunity Owner and a suggested SE (from Sales Team Alignment on that owner)' },
      { category: 'improvement', text: 'SE Credit and Coverage-by-rep-pipeline tables always render (with clear empty states) so they no longer disappear' },
      { category: 'improvement', text: 'Removed the "Coming soon" cost banner from the Most Expensive dashboard' },
    ],
  },
  {
    version: '1.193.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Attach Rate redefined as tiered: Primary (Assigned SE) vs Secondary (an evaluation field or an opp activity when no Assigned SE)' },
      { category: 'feature', text: 'New decorative KPI tiles: Attach Rate %, ACV %, Attached #/$, and Primary/Secondary #+%' },
      { category: 'feature', text: '"Missing Assigned SE" worklist — opps attached only via secondary signals (someone forgot to set the Assigned SE)' },
      { category: 'improvement', text: 'Attached-by-SE now shows Top 5 by opps and Top 5 by ACV; breakdown tables show SE Credit (share) and rep-pipeline Primary/Secondary coverage' },
    ],
  },
  {
    version: '1.192.0',
    date: '2026-07-30',
    highlights: [
      { category: 'feature', text: 'Attach Rate: new SE Attach Rate by ACV card (Opportunity Amount-weighted) and an Attached-by-role card' },
      { category: 'feature', text: 'New Team / Sub-team / User breakdown tables — rep-pipeline coverage (via Sales Team Alignment) and SE credit' },
      { category: 'improvement', text: 'Sales Stage / Forecast filters now list the full Salesforce picklist instead of only values seen on activities' },
      { category: 'improvement', text: 'Admin → Attach Rate Fields: per-field editable Role label' },
    ],
  },
  {
    version: '1.191.0',
    date: '2026-07-30',
    highlights: [
      { category: 'fix', text: 'Fixed Attach Rate "Refresh from Salesforce" returning 400 — the global refresh no longer requires a team-scoped role check, and the header button now sends the CSRF token' },
      { category: 'improvement', text: 'Attach Rate per-SE breakdown now resolves Salesforce User IDs to names automatically (via a User-name cache), so it no longer shows raw IDs' },
      { category: 'improvement', text: 'Removed the confusing per-field "Values" control from Attach Rate Fields — ID vs name is detected automatically' },
    ],
  },
  {
    version: '1.190.1',
    date: '2026-07-30',
    highlights: [
      { category: 'fix', text: 'Fixed Attach Rate "Refresh from Salesforce" failing with a rate-limit error — the self-throttled SF refresh is now exempt from the global per-IP request cap' },
      { category: 'improvement', text: 'Refresh now shows a clear cooldown message for any rate-limit/throttle response instead of a generic failure' },
    ],
  },
  {
    version: '1.190.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Attach Rate date-basis picker now shows an icon and a description for each choice' },
      { category: 'feature', text: 'Open Pipeline gains week-over-week Compare and a weekly trend, from a new lightweight per-team history recorded on each coverage refresh' },
      { category: 'improvement', text: 'Refresh from Salesforce now gives feedback (updated / recently-refreshed cooldown / failed) instead of appearing to do nothing' },
      { category: 'fix', text: 'Fixed a filtered empty cohort being mislabelled “no snapshot yet” — it now reads “no opportunities match”' },
    ],
  },
  {
    version: '1.189.0',
    date: '2026-07-30',
    highlights: [
      { category: 'feature', text: 'Attach Rate fields can now live on a related object (e.g. Evaluations__c) — the coverage job rolls those records up to the parent Opportunity via a configurable link field' },
      { category: 'improvement', text: 'Per-field control over whether values are Salesforce User IDs (resolved to names) or already-name multi-selects' },
      { category: 'improvement', text: 'Attach Rate Fields admin regained its description (with which dashboard uses it)' },
    ],
  },
  {
    version: '1.188.1',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Admin → Attach Rate Fields: SF Object is now a dropdown, rows are editable inline, and field names autocomplete from Salesforce' },
      { category: 'fix', text: 'Fixed the panel background so it renders correctly in dark mode' },
    ],
  },
  {
    version: '1.188.0',
    date: '2026-07-30',
    highlights: [
      { category: 'improvement', text: 'Attach Rate now reads from a local Salesforce opportunity snapshot (refreshed nightly + on manual refresh), so Compare and the weekly trend load instantly without hammering Salesforce' },
      { category: 'improvement', text: 'Date basis toggle — measure attach rate by Created date, Close date, or current Open pipeline' },
      { category: 'improvement', text: 'Weekly attach-rate trend and WoW/MoM/QoQ/YoY Compare on the coverage number' },
    ],
  },
  {
    version: '1.187.0',
    date: '2026-07-30',
    highlights: [
      { category: 'feature', text: 'New Attach Rate dashboard (Coverage group) — the share of Salesforce opportunities with a Solutions Engineer attached, sliceable by Sales Stage and Forecast Category' },
      { category: 'improvement', text: 'Per-SE breakdown of attached opportunities, read live from Salesforce' },
      { category: 'feature', text: 'New Admin → Attach Rate Fields screen to configure which SF fields count as an SE being attached (seeded with the standard Opportunity SE fields)' },
    ],
  },
  {
    version: '1.186.4',
    date: '2026-07-29',
    highlights: [
      { category: 'fix', text: 'The nudge snooze menu now renders in a portal so it is never clipped by the notifications panel — all durations (1 / 7 / 30 days) show fully' },
    ],
  },
  {
    version: '1.186.3',
    date: '2026-07-29',
    highlights: [
      { category: 'fix', text: 'Snooze menu now opens beside the bell notification so all durations (1 / 7 / 30 days) are visible without scrolling' },
      { category: 'fix', text: 'Reading or snoozing a nudge from the bell now clears its Weekly-view banner immediately, without a page refresh' },
    ],
  },
  {
    version: '1.186.2',
    date: '2026-07-29',
    highlights: [
      { category: 'security', text: 'Security hardening from CodeQL review: removed user-controlled values from log format strings, replaced naive one-pass HTML tag stripping with the hardened fixpoint helper, and rewrote the attendee-email regex to be linear (no ReDoS)' },
    ],
  },
  {
    version: '1.186.1',
    date: '2026-07-29',
    highlights: [
      { category: 'fix', text: 'Marking a nudge read now sticks — it no longer flips back to unread on the next poll' },
      { category: 'improvement', text: 'Reading a nudge also clears its Weekly-view banner and bottom toast for the rest of the day (they re-alert tomorrow if still relevant)' },
    ],
  },
  {
    version: '1.186.0',
    date: '2026-07-29',
    highlights: [
      { category: 'fix', text: 'Fixed the "Some nudges couldn\'t sync" notification error — the nudge upsert now targets its partial unique index correctly' },
      { category: 'improvement', text: 'Nudge History now records in-app (and Slack/email) nudge deliveries, once per rule per day, so the page is no longer empty' },
      { category: 'improvement', text: 'Login History now shows the sign-in method/provider (Okta, Azure, TOTP) for active sessions instead of a blank column' },
    ],
  },
  {
    version: '1.185.1',
    date: '2026-07-29',
    highlights: [
      { category: 'fix', text: 'Dark mode: fixed low-contrast / dark-on-dark text across the dashboards by giving the app a themed base text color' },
      { category: 'fix', text: 'Dark mode: native date/time pickers (including the Log Activity drawer) and other browser controls now follow the theme, so the calendar icons are no longer black on dark backgrounds' },
    ],
  },
  {
    version: '1.185.0',
    date: '2026-07-29',
    highlights: [
      { category: 'improvement', text: 'The "Show Costs In" currency selector and FX date now live once in the dashboard header and apply to every cost dashboard (Cost per ACV, Opportunity ROI, Most Expensive, Team-of-Teams Rollup, User Leaderboard, Project-Specific Costing) — all cost, ACV, and margin figures convert to the chosen currency' },
      { category: 'improvement', text: 'The header currency defaults to your My Settings preferred currency' },
      { category: 'improvement', text: 'Activity page: the Compact Approved Activity Cards button uses a clearer list-collapse icon' },
    ],
  },
  {
    version: '1.184.1',
    date: '2026-07-29',
    highlights: [
      { category: 'improvement', text: 'Hid the Compare (WOW/MOM/QOQ/YOY) selector on the 7 dashboards that do not use it: Opportunity ROI, Cost per ACV, Most Expensive, Team-of-Teams Rollup, Sales Team Breakdown, User Leaderboard, and Project-Specific Costing' },
    ],
  },
  {
    version: '1.184.0',
    date: '2026-07-29',
    highlights: [
      { category: 'improvement', text: 'Project-Specific Costing now honors the Subteam filter — picking a subteam scopes the whole tree to its members instead of showing everyone' },
      { category: 'improvement', text: 'Weekly view: the two expand/collapse day buttons are now a single toggle, matching the dashboard' },
    ],
  },
  {
    version: '1.183.1',
    date: '2026-07-29',
    highlights: [
      { category: 'improvement', text: 'Localized the "Unassigned" bucket label in the Project-Specific Costing Team/Subteam view across all 7 languages' },
    ],
  },
  {
    version: '1.183.0',
    date: '2026-07-29',
    highlights: [
      { category: 'improvement', text: 'Project-Specific Costing now drills in: every scope is an expandable, roll-up tree — Projects → contributors, Opportunities → projects, Accounts → opportunities → projects, and Team/Subteam → projects, with a collapse-all toggle (collapsed by default)' },
      { category: 'improvement', text: 'Dashboard header tightened: the dashboard picker moved up next to the timezone note and the filters are left-aligned' },
    ],
  },
  {
    version: '1.182.0',
    date: '2026-07-29',
    highlights: [
      { category: 'feature', text: 'New Infrastructure dashboard category with the Project-Specific Costing dashboard: Activities, Hours, Cost, ACV, and Contributors for every captured project' },
      { category: 'improvement', text: 'Icon toggle rolls project activity up by Project, Opportunity, Account, or Team/Subteam, with project-scoped KPI cards and Sales Stage / Forecast filters' },
    ],
  },
  {
    version: '1.181.2',
    date: '2026-07-28',
    highlights: [
      { category: 'improvement', text: 'Login screen: updated the subtitle to "Use your assigned credentials", removed the "Local password sign-in. Okta SSO coming soon." footer, and tightened the card' },
      { category: 'improvement', text: 'Removed the stale "cost calculations coming soon" banner from the User Leaderboard dashboard' },
    ],
  },
  {
    version: '1.181.1',
    date: '2026-07-28',
    highlights: [
      { category: 'security', text: 'Security hardening: all Salesforce SOQL query building now uses the complete escape helper (backslash + quote); MFA backup codes use unbiased random selection; the HTML-to-text email helper strips tags to a fixpoint and decodes entities safely' },
    ],
  },
  {
    version: '1.181.0',
    date: '2026-07-28',
    highlights: [
      { category: 'security', text: 'Added a global, admin-configurable rate limiter (Admin → Integrations → Rate Limiting) — enable/disable + requests-per-window, applied live without a restart; default 300 req / 5 min per IP' },
      { category: 'security', text: 'Tighter limit on manual calendar refresh; hardened query-parameter parsing across scheduling/nudges/Salesforce routes (CodeQL type-confusion) and the holiday-refresh country code (CodeQL SSRF)' },
    ],
  },
  {
    version: '1.180.1',
    date: '2026-07-28',
    highlights: [
      { category: 'improvement', text: 'The "Suggested from attendees" card in the Log Activity drawer now shows Owner + Close date on Opportunities and Owner on Accounts, matching the Salesforce Link search' },
    ],
  },
  {
    version: '1.180.0',
    date: '2026-07-28',
    highlights: [
      { category: 'improvement', text: 'Approving a suggested activity now runs pre-checks: it blocks (and opens Edit) if no Product, no Account/Opportunity, or Eval Work without an Evaluation; and asks you to confirm the Assigned SE, activity type, and on-site travel costs' },
      { category: 'improvement', text: 'Salesforce search now shows Owner + Stage + Close date for Opportunities and, for Campaigns, Created By + Start/End dates — in both the drawer and the card suggestion pills' },
    ],
  },
  {
    version: '1.179.0',
    date: '2026-07-28',
    highlights: [
      { category: 'security', text: "My Notes: MEDDPICC on another user's note is now view-only — non-owners (and App Admins) can read but not edit or save it" },
      { category: 'improvement', text: 'My Notes: each filled MEDDPICC field shows a small lettered badge (M/E/D/D/P/I/C/C) in the note list' },
      { category: 'improvement', text: 'My Notes: the "Ask My Notes" AI search moved to the top of the note' },
      { category: 'feature', text: 'My Settings: "Sync from Outlook" pulls your working days + hours from your Outlook mailbox (review, then Save)' },
    ],
  },
  {
    version: '1.178.1',
    date: '2026-07-28',
    highlights: [
      { category: 'improvement', text: 'Log Activity drawer: every field label (Title, Type, Start/End Time, Effort Hours, Salesforce Link, ACV, Products, Location, Meeting Owner, Attendees, Event Description, Notes, Assigned SE) now leads with an icon' },
      { category: 'improvement', text: 'Incidental Costs popup: Transportation, Lodging, and Food labels get matching icons, and the Done button gets a checkmark' },
    ],
  },
  {
    version: '1.178.0',
    date: '2026-07-28',
    highlights: [
      { category: 'feature', text: 'New Azure SSO (Microsoft Entra ID) login — configure it under Admin → Integrations; a "Sign in with Microsoft" button appears alongside Okta on the login screen' },
      { category: 'feature', text: 'Azure SSO supports JIT auto-provisioning (new users created as Contributor with no team) or require-precreated' },
      { category: 'improvement', text: 'Subteams: Edit is now inline (name, kind, and parent) and keeps existing leaders/members — no more browser prompt' },
      { category: 'improvement', text: 'Removed the duplicate Subteams section header in Team Management' },
    ],
  },
  {
    version: '1.177.0',
    date: '2026-07-28',
    highlights: [
      { category: 'feature', text: 'Subteams can now nest up to 4 levels deep via a parent-subteam picker in Team Management' },
      { category: 'improvement', text: 'Team Management shows leader + member pills and text-labeled row actions' },
      { category: 'improvement', text: 'A user can belong to at most 4 subteams' },
      { category: 'improvement', text: 'Team-of-Teams Rollup renders the subteam hierarchy and counts each activity once at the deepest subteam, rolling up into parents' },
    ],
  },
  {
    version: '1.176.1',
    date: '2026-07-28',
    highlights: [
      { category: 'improvement', text: 'Incidental (Direct) Costs now attach to On-site activities instead of Remote — travel spend belongs with on-site meetings' },
      { category: 'improvement', text: 'Restyled the Incidental Costs button with a light orange background and dark orange icon' },
    ],
  },
  {
    version: '1.176.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Renamed the "Cost per $ of ACV" dashboard to "Total Cost of Engagement (TCE)" (dashboard, Role Management, and the money column)' },
      { category: 'feature', text: 'Log Activity: Remote activities can now capture Incidental Costs (Transportation, Lodging, Food) via a popup, entered in your display currency' },
      { category: 'improvement', text: 'These "Direct Costs" now roll into every cost dashboard: a new Direct Costs column on TCE (before the TCE total), and folded into Most Expensive, User Leaderboard, Manager Rollup, and Opp ROI — which are now FX-normalized to USD' },
    ],
  },
  {
    version: '1.175.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Capacity groups now honor their Capacity Method: Fixed Hours = the group target; Self-Declared / Exception-Adjusted = the user\'s own work-week hours, floored at the group minimum. A per-user override still overrides everything (the only way below the floor)' },
      { category: 'improvement', text: 'Dashboard PTO/holiday reductions now use each user\'s configured hours/day instead of a flat 8h, so dashboard capacity matches the Activities-page weekly capacity exactly' },
    ],
  },
  {
    version: '1.174.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'This-Week Capacity % now counts total time used (logged + non-activity meetings) against target and is shown to the tenth of a percent' },
    ],
  },
  {
    version: '1.173.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'The Activities-page Weekly Capacity donut now shows uncaptured "other meetings" as a grey arc, matching the bar' },
      { category: 'improvement', text: 'The Weekly Capacity bar percentage now reflects logged + other-meeting time combined, so a meeting-heavy week no longer reads as ~0%' },
    ],
  },
  {
    version: '1.172.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Capacity dashboards now include uncaptured Outlook meeting time ("non-activities") in dark grey: split cells on Team Heatmap, a grey segment on This-Week Capacity, and a black split on Capacity Trend' },
      { category: 'feature', text: 'New "Include Non-Activities" toggle at the top of the capacity dashboards (on by default), matching the Activities page toggle' },
      { category: 'improvement', text: 'Team names must now be unique — create/rename/clone are blocked on a duplicate, and duplicate-named teams show a warning badge in Team Management' },
    ],
  },
  {
    version: '1.171.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'App admins can now open any team\'s admin config (Activity Types, SF Mappings, etc.) even without a team_members row — fixes team-scoped config screens showing empty for teams like Channel' },
      { category: 'improvement', text: 'Team Heatmap now shows the shared "no data" empty state when a team has no members or activity, instead of rendering blank' },
      { category: 'fix', text: 'Added the missing "no activity types yet" message in all 7 locales (was showing the raw admin.activity_types.empty key)' },
      { category: 'improvement', text: 'Weekly capacity bar now includes a dark-grey segment for Outlook meetings that aren\'t logged as activities (Non-Activity or uncategorized), for a complete picture of time used' },
    ],
  },
  {
    version: '1.170.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Outlook write-back now honors the configured internal-domain list exactly — an attendee whose domain is in the list (including test domains like example.com.invalid) gets a real Outlook invite instead of being pushed to the external-attendees note' },
      { category: 'security', text: 'Removed the temporary /api/outlook/debug diagnostic endpoint' },
    ],
  },
  {
    version: '1.169.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Leader dashboards now show the normal "no data" empty state instead of spinning forever when a team has no activity or when "All Teams" resolves to an empty scope' },
    ],
  },
  {
    version: '1.168.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Outlook debug endpoint now also returns the user\'s team memberships and each activity\'s team name, to diagnose team-scoping mismatches (an activity on a non-selected team is hidden from the day list).' },
    ],
  },
  {
    version: '1.167.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Re-approving a meeting that was previously deleted now reactivates the existing activity instead of creating a duplicate (dedup matches archived rows too)' },
      { category: 'fix', text: 'Migration 0095 cleans up existing redundant archived duplicate activities that share an Outlook event with a still-active activity' },
    ],
  },
  {
    version: '1.166.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Added a read-only Outlook diagnostic endpoint (GET /api/outlook/debug) that shows live Graph events vs the cached calendar vs activities, to pinpoint why a specific meeting/activity isn’t syncing' },
    ],
  },
  {
    version: '1.165.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Fix: an approved activity whose activity-type row was removed no longer disappears from the weekly list (the list now left-joins the type and shows a placeholder) — it stays visible and editable' },
      { category: 'fix', text: 'Outlook calendar sync now follows pagination (all events, not just the first 100), so busy calendars no longer drop real events from the ImpactIQ calendar during the delete-reconcile step' },
    ],
  },
  {
    version: '1.164.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'An activity written back to Outlook now appears on the ImpactIQ calendar immediately (cached on write), instead of only after the next calendar sync' },
    ],
  },
  {
    version: '1.163.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Fix: logging a new activity no longer loses the Meeting owner / Attendees you typed — a background calendar refetch was resetting the open form' },
      { category: 'improvement', text: 'Deleting an activity + its Outlook event now warns that removal from both systems can take up to ~2 minutes to propagate' },
      { category: 'feature', text: 'Scheduling: new icon toggle to switch the grid between the full 24-hour day and work hours only' },
    ],
  },
  {
    version: '1.162.0',
    date: '2026-07-27',
    highlights: [
      { category: 'feature', text: 'Outlook write-back now uses a configurable "Internal email domains" list (Admin → Integrations) to decide which attendees get a real Outlook invite; everyone else stays in the event description' },
      { category: 'improvement', text: 'The Log Activity drawer note now names the exact internal domain(s), so you know who will be invited vs added to the description only' },
    ],
  },
  {
    version: '1.161.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'The Outlook calendar panel now refreshes on tab focus and re-syncs more promptly, so an event deleted in Outlook disappears without a manual refresh' },
      { category: 'feature', text: 'Attendees field: a "Search Salesforce contacts & users" picker is always available when Salesforce is connected, matching the Meeting owner search' },
      { category: 'improvement', text: 'Refresh-from-Outlook button now shows the live remaining time (mm:ss) in its hover tooltip while throttled' },
      { category: 'improvement', text: 'Outlook write-back sets internal attendees as real Required attendees (they get an Outlook invite); external attendees stay in the event description only, with a heads-up note in the Log Activity drawer' },
    ],
  },
  {
    version: '1.160.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'The red "Outlook only" pill now shows on any submitted activity that has no Salesforce link (not just ones written to Outlook), and appears immediately on approval' },
    ],
  },
  {
    version: '1.159.0',
    date: '2026-07-27',
    highlights: [
      { category: 'improvement', text: 'Outlook write-back events now include the event description, meeting owner, and attendee list in the event body (attendees are captured as text, so no meeting invites are sent)' },
      { category: 'improvement', text: 'The "On Outlook" / "Outlook only" pills now appear automatically once the write-back completes — no page refresh needed' },
      { category: 'improvement', text: 'Deleting an activity that was written to Outlook now offers to delete the calendar event too, so it no longer lingers in Outlook or reappears as an unapproved suggestion' },
    ],
  },
  {
    version: '1.158.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Outlook write-back events now open in your own timezone (e.g. America/New_York) instead of showing as Coordinated Universal Time' },
      { category: 'improvement', text: 'Activity cards show a red "Outlook only" pill next to the created date when an activity was written to your Outlook calendar but isn’t in Salesforce' },
    ],
  },
  {
    version: '1.157.0',
    date: '2026-07-27',
    highlights: [
      { category: 'fix', text: 'Fix: an activity written to your Outlook calendar no longer reappears as a duplicate "suggested meeting" on the Activities list — the created event is recognized as already logged' },
      { category: 'fix', text: 'Fix: deleting an ImpactIQ-created event in Outlook now removes it from the Activities calendar panel (the sync reconciles events deleted in Outlook, not just aged-out ones)' },
      { category: 'improvement', text: 'The Log Activity drawer now asks you to confirm before creating a new Outlook event when calendar write-back is enabled' },
    ],
  },
  {
    version: '1.156.0',
    date: '2026-07-24',
    highlights: [
      { category: 'feature', text: 'Optional Outlook calendar write-back: opt in under Settings → Connections and ImpactIQ will create an event on your own Outlook calendar when you log an activity (and update it if you edit the activity)' },
      { category: 'improvement', text: 'Only activities that aren\'t already tied to a meeting are written, so real meetings are never duplicated; a clear notice explains that events are created on your calendar' },
      { category: 'improvement', text: 'Requires the delegated Calendars.ReadWrite permission and reconnecting Outlook (see Admin → Integrations instructions and docs/outlook-writeback.md)' },
      { category: 'improvement', text: 'Activity cards show an "On Outlook" badge; the write-back worker appears on Admin → Monitoring → Scheduling' },
    ],
  },
  {
    version: '1.155.0',
    date: '2026-07-24',
    highlights: [
      { category: 'improvement', text: 'Scheduling free/busy now includes logged activities, not just Outlook events — so manually-created / Salesforce-sourced activities (with no calendar meeting behind them) finally show on the grid and in capacity' },
      { category: 'feature', text: 'New View toggle: All (calendar + logged, deduped), Calendar (Outlook only), or Logged (activities only) — to compare what\'s booked vs what got logged' },
    ],
  },
  {
    version: '1.154.0',
    date: '2026-07-24',
    highlights: [
      { category: 'improvement', text: 'Scheduling page now has an Activities-style week header: date range, fiscal-quarter chip, timezone label, prev/next/Today, a weekend on/off toggle, and capacity chips (people, busy hours, % utilization)' },
      { category: 'improvement', text: 'Grid shows the full 24-hour day with hours stretched to fill the panel (half/quarter-hour guides); non-working hours and weekend columns are shaded like the Activities calendar in both light and dark mode; a timezone dropdown re-renders the week in any teammate\'s zone' },
      { category: 'improvement', text: 'Each user is tagged with their timezone acronym (e.g. [EDT]); Common / Per User free-time toggle gained icons' },
      { category: 'improvement', text: 'Role Management now lists Scheduling and My Notes (granted to all roles by default, admin-revocable)' },
    ],
  },
  {
    version: '1.153.0',
    date: '2026-07-24',
    highlights: [
      { category: 'feature', text: 'New Scheduling page: a full-width team free/busy week grid with a free-time finder and weekly-capacity panel on the right, plus multi-select Subteam / Team-member filters' },
      { category: 'improvement', text: 'Find common open windows across a group ("all N free") or switch to per-user free blocks; aggregate + expandable per-user utilization vs weekly capacity target' },
      { category: 'security', text: 'Privacy is enforced server-side — a contributor sees only their own event detail; teammates render as anonymized colored busy blocks (leaders / admins see per-person detail)' },
      { category: 'improvement', text: 'Bounded, throttled Refresh from Outlook (max 15 users per click, 1 / 10 min per caller)' },
    ],
  },
  {
    version: '1.152.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Migration 0092 corrects the seeded Evaluation date field API names to the real ones (Start Date → Install_Date__c, End Date → License_Key_Expiration__c) so a deploy / fresh install maps them right. Only rows still holding the old seeded value are touched, so admin-corrected mappings are left alone' },
    ],
  },
  {
    version: '1.151.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: editing a Project field failed with "expected string, received undefined" — the PATCH body used a Zod enum-keyed record, which in Zod 4 requires every key. Now an all-optional object, so saving a single field works' },
      { category: 'improvement', text: 'Admin → SF Field Mappings: widened the SF Object column (70px → 130px) so long custom object names like "Evaluations__c" no longer get cut off / overlap the App Field' },
    ],
  },
  {
    version: '1.150.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Project fields showed blank because one mis-seeded Evaluation field API name (e.g. "Eval_EndDate" missing its __c) failed the entire SOQL SELECT. Both the live read and the nightly refresh now describe the object and drop any field that doesn\'t exist, so the valid fields populate and only the bad one stays blank until an admin corrects it' },
      { category: 'improvement', text: 'Admin → SF Field Mappings: the Evaluation app fields (Project Name / Status / Stage / Type / Start Date / End Date) now appear in the App Field dropdown, so the edit form shows the mapping instead of a blank "—"' },
    ],
  },
  {
    version: '1.149.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Evaluation (Project) fields showed blank and the SF Field Mappings edit dropdown pointed at the wrong object — v1.148 hardcoded the object name as "Evaluation__c" but the real object is whatever the admin configured (e.g. "Evaluations__c"). The whole feature is now object-name-agnostic: the SF object comes from the picker config / activity sfRelatedType, never a hardcoded literal' },
      { category: 'fix', text: 'Migration 0091 corrects the seeded Evaluation field mappings\' SF Object to the real API name derived from the team\'s Project picker config' },
      { category: 'improvement', text: 'Project panel now reads live Salesforce values (not just the nightly snapshot), so a just-linked Project shows its Status / Stage / Type / dates immediately' },
      { category: 'fix', text: 'Fix: the Project drill-in modal\'s fields are now collapsed by default (compact Status/Stage/Type, click to expand the full editor) instead of always-expanded' },
    ],
  },
  {
    version: '1.148.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Log Activity form: the Project (Evaluation) picker now renders below the Opportunity Info block (ACV / Sales Stage / Forecast / Close Date), matching the natural read order' },
      { category: 'improvement', text: 'When a Project is linked, a compact info box shows its Status / Stage / Type; clicking the Project name expands an inline editor for all 5 Evaluation fields (Status, Stage, Type, Start Date, End Date) — edits write live to Salesforce' },
      { category: 'improvement', text: 'Same Project fields panel now appears — always visible and editable — in the Project drill-in modal' },
      { category: 'improvement', text: 'Project chips (activity card, drill-in modal) now show an icon matching the Evaluation Type: Target (POC), Cloud (Virtual Lab), CirclePlay (RTU), Forklift (Trial), Handshake (Partner NFR / Partner Lead)' },
      { category: 'improvement', text: 'Admin → SF Field Mappings: 6 new Evaluation__c mappings seeded per team (Name, Status, Stage, Type, Start Date, End Date) — Read & Write, nightly background refresh' },
      { category: 'feature', text: 'New nightly refresh pass for Evaluation__c records alongside the existing Opportunity refresh, keeping Project fields in sync even when nobody edits them in-app' },
    ],
  },
  {
    version: '1.147.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations → MCP Server: the Turn on/off pill now carries a leading icon (Power / PowerOff) per the app-wide icon-before-label convention' },
      { category: 'improvement', text: 'MCP Server page adds a direct "Create an mcp:read key in My Settings → API Keys" link so admins don\'t have to hunt for where to generate the Bearer token' },
    ],
  },
  {
    version: '1.146.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'docs/mcp.md: expanded Roadmap into v2 (writes — mcp:write scope, activities.create/submit, notes.create, salesforce.suggestion_override, gated on an audit-log enum expansion + a via column) and v3 (governance & scale — per-tool ACL, Redis rate limiter, Cowork connector listing, UI-configurable quotas) sections, plus an explicit "deferred indefinitely" list' },
      { category: 'improvement', text: 'CLAUDE.md Phase Boundaries updated to reflect the same v2/v3 MCP breakdown' },
    ],
  },
  {
    version: '1.145.0',
    date: '2026-07-23',
    highlights: [
      { category: 'feature', text: 'MCP (Model Context Protocol) server — read-only. LLM agents (Claude Desktop, Claude Code, Cursor, n8n MCP Client Tool, Cowork) can query ImpactIQ at POST /api/mcp. Tools: dashboards.manager_rollup, activities.list, activities.get, users.list, teams.list, salesforce.search_opportunities' },
      { category: 'security', text: 'Scoped API keys: new mcp:read scope. MCP tokens can only call MCP tools; rest:full tokens can only call REST. Existing keys default to rest:full so nothing breaks. Scope picker added to My Settings → API Keys' },
      { category: 'feature', text: 'Admin → Integrations → MCP Server: tenant on/off kill switch + copy-paste config snippets for n8n and Claude Desktop' },
      { category: 'feature', text: 'Admin → Monitoring → MCP Activity: audit log of every tool call (tool, status, latency, token, user), 30-day retention, per-token daily stats' },
      { category: 'security', text: 'Per-token rate limits (60/min, 1000/hr) + tenant daily cap (5000/day), all env-configurable. 429 with Retry-After. Full docs at docs/mcp.md' },
    ],
  },
  {
    version: '1.144.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Sync History only showed one user because AUDIT_RETENTION_DAYS was 5 — activities the other user last synced more than 5 days ago had already been culled by the sync_audit_cull job. Bumped to 30 days so the page reliably shows every user who synced recently. Matches the nudge_history retention window. Description text updated across all 7 locales.' },
    ],
  },
  {
    version: '1.143.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Docs refresh: README + CLAUDE.md updated for v1.142 reality — 4-role RBAC, 15 dashboard tabs including Most Expensive + User Leaderboard, Scheduling admin page, background-refresh SF field mappings, Italian locale (7 total, was 6), JSForce v3, updated phase-boundary list' },
      { category: 'improvement', text: 'docs/api.md regenerated — was showing 96 endpoints, now shows all 330. New /api/dashboards/{most-expensive, user-leaderboard, refresh-opp-snapshots, stage-forecast-options} and /api/admin/scheduling routes now documented' },
      { category: 'improvement', text: 'docs/db-schema.md regenerated — includes job_runs, job_config, sf_snapshot_state, sf_lead_account_link, sf_field_mappings.background_refresh + refresh_only_for_reports flags' },
    ],
  },
  {
    version: '1.142.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Removed duplicate in-page titles on Sync History, Nudge History, and Scheduling — the Admin section nav header already shows the page name, so the repeated h2 + icon inside the page was redundant. Descriptions kept.' },
    ],
  },
  {
    version: '1.141.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings Add Mapping form gains Active + Background refresh + Refresh only for reports checkboxes (were only in the Edit modal). Background refresh + Refresh-only are now independent toggles — neither grays the other out' },
      { category: 'fix', text: 'refresh_opp_snapshots SOQL error fix: custom relationship fields (Assigned_SE__r.Name / Primary_Engineer__r.Name / Evaluation__c) are no longer in CORE_SELECT. The refresher now runs a one-shot Opportunity describe on each cycle and filters the extra field list down to fields the org actually has. Custom fields still flow via sf_field_mappings for orgs where they exist' },
      { category: 'improvement', text: 'Scheduling Recent-runs table now renders status with the same colored icon pill as the top table (was raw enum text)' },
      { category: 'feature', text: 'New per-job "Email admins on error" checkbox on the Scheduling page. When on, a run failure emails every App Admin (max once per calendar day per job) — stored in a new job_config table with lastErrorEmailAt de-dup' },
    ],
  },
  {
    version: '1.140.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings Edit modal now exposes two checkboxes: Background refresh (nightly) and Refresh only for reports (no writeback). Row list also renders both states with a distinct violet "Refresh: report-only" chip' },
      { category: 'improvement', text: 'New refresh_only_for_reports column on sf_field_mappings. Migration 0087 also seeds every existing team with 11 refresh-only Opportunity mappings so admins can SEE what the nightly refresher pulls: StageName, ForecastCategoryName, Amount, IsClosed, IsWon, CloseDate, OwnerId, Owner.Name, Assigned_SE__r.Name, Primary_Engineer__r.Name, Evaluation__c' },
      { category: 'improvement', text: 'Writeback service skips refresh-only rows — even if direction includes write, the mapping is treated as read-only in the push path (Salesforce is source of truth for these fields)' },
      { category: 'improvement', text: 'i18n added for the new labels + chip variant across all 7 locales' },
    ],
  },
  {
    version: '1.139.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'SF Field Mappings row layout fix: the v1.138 Refresh chip pushed each row onto a second line. The row now stays on ONE line — Status + Refresh share a single grid cell (flex, no-wrap), SF API Field column narrowed slightly to make room, and the Status column widened to 180px so both pills fit inline' },
    ],
  },
  {
    version: '1.138.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Dashboards → Accounts → Most Expensive and Management → User Leaderboard were empty because their auth middleware required a teamId in the querystring — switched both to requireAuth (like Manager Rollup) so they scan every team the caller can see' },
      { category: 'feature', text: 'Refresh from Salesforce now runs nightly (every 24h from boot + kick 60s after startup) — no manual click required to keep Sales Stage / Forecast fresh. Manual button still available for on-demand refresh' },
      { category: 'improvement', text: 'Refresh payload extended: pulls Assigned SE, Primary Engineer, Opp Owner, Close Date, Evaluation lookup in addition to Stage / Forecast / Amount / IsClosed / IsWon. Snapshots into new activities columns sf_primary_engineer_name / sf_opp_owner_id / sf_opp_owner_name / sf_opp_close_date' },
      { category: 'improvement', text: 'Admin → SF Field Mappings gets a per-row "Refresh: on/off" chip. Turning it on for a mapping adds that SF field to the nightly refresh SELECT. Applies to any Opportunity-scoped mapping' },
      { category: 'feature', text: 'New Admin → Monitoring → Scheduling page — read-only table listing every registered background job with cadence, last run, duration, status, and last error. Powered by a new job_runs audit table' },
      { category: 'improvement', text: 'Admin secondary sidebar now scrolls (overflow-y-auto) so long nav lists no longer clip below the viewport' },
      { category: 'improvement', text: 'i18n sweep — v1.137 leader keys (most_expensive.*, user_leaderboard.*, coming_soon_costs, filter_sales_stage, filter_forecast, refresh_from_sf) now have proper translations across es / de / fr / ja / pt / it (were English stopgaps in v1.137). New admin.scheduling.* keys added the same way' },
    ],
  },
  {
    version: '1.137.0',
    date: '2026-07-23',
    highlights: [
      { category: 'feature', text: 'New Dashboards → Accounts → Most Expensive: top 25 ranked by cost of effort with an icon toggle for Accounts / Opps / Campaigns / Leads. Account view rolls up child Opp cost + Lead-converted-to-Account cost. Horizontal bar chart above the ranked table' },
      { category: 'feature', text: 'New Dashboards → Management → User Leaderboard: per-user Total ACV, Closed ACV, Cost, Net Deal Margin (ACV − Cost) and Efficiency Ratio (Closed ACV ÷ Cost). Top-10 by ACV bar chart above the sortable table' },
      { category: 'feature', text: 'Global Sales Stage + Forecast Category filter chips appear on Manager / Revenue / Accounts groups only. Filters apply against activities\' SF snapshot columns' },
      { category: 'feature', text: 'Manual "Refresh from Salesforce" button (RefreshCw icon, 10-min-per-user throttle) hits Opportunity in bulk, updates every linked activity\'s Stage / Forecast / IsWon flags, and refreshes the Lead → Account link cache used by the Account rollup' },
      { category: 'improvement', text: 'Coming-soon banner on both new dashboards: CloudLAB compute + travel spend will be added to the cost formula in a future release' },
    ],
  },
  {
    version: '1.136.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Team-of-Teams Rollup: "Most Expensive Account" KPI now reflects the actual ACTIVITY COST (sum of effort hours × resolved cost rate) attributed to the account — not the account\'s rolled-up ACV. Attribution covers both direct Account activities and every Opp\'s parent Account snapshot' },
    ],
  },
  {
    version: '1.135.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Team-of-Teams Rollup table: numeric column HEADERS now center-align to match their center-aligned data cells (Hours, Cost, ACV, Activities, Contributors, Accounts, Leads, Campaigns, Opps). Only the Team column stays left. v1.133 centered the data but the headers were still leaning left because SortableTh needed the align prop, not a text-center className' },
    ],
  },
  {
    version: '1.134.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Dashboard filter chips now carry icons — Subteam chip gets a Users icon, Team member gets a User icon, Products gets a Package icon. Icon renders on the trigger label AND on every option row' },
      { category: 'improvement', text: 'Products dropdown shows each product\'s uploaded icon (data URL) next to its name; falls back to the generic Package glyph when a product hasn\'t been uploaded a custom icon in Admin → Products' },
      { category: 'improvement', text: 'SingleSelect and MultiSelect both learned a labelIcon prop; MultiSelect also gained per-option icon (lucide component) + iconUrl (image / data URI) so any other picker in the app can pass the same pattern' },
    ],
  },
  {
    version: '1.133.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Team-of-Teams Rollup: table now shows Accounts / Leads / Campaigns / Opps as four separate unique-count columns (previously only Opps). Accounts counts direct Account links plus every Opp\'s parent Account. Leads read from sfWhoType; Campaigns and Opps from sfWhatType' },
      { category: 'improvement', text: 'All table columns (Hours, Cost, ACV, Activities, Contributors, Accounts, Leads, Campaigns, Opps) are now center-aligned — headers and data — instead of right-aligned' },
      { category: 'improvement', text: 'KPI stat cards redesigned as colorful tiles with a leading icon in a rounded tint, big bold value, and a large decorative watermark icon in the top-right — one color per metric (indigo Hours, rose Cost, emerald ACV, sky Activities, amber Most-expensive-account, violet Biggest-impact-user)' },
      { category: 'feature', text: 'Two new KPI cards: Most Expensive Account (highest rolled-up ACV across accounts, deduped per Opp) and Biggest Impact user (highest ACV attributed to a single contributor across their touched Opps)' },
    ],
  },
  {
    version: '1.132.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Team-of-Teams Rollup now actually loads. The ACV subquery selected `activities.teamId` on the outer query while the outer FROM was the `per_opp` derived table, so drizzle threw "Your teamId field references a column activities.team_id, but the table activities is not part of the query" and the whole endpoint 500\'d — which is why the dashboard has been rendering the empty state despite live activity data. Now sums max(acv) grouped by opportunity in JavaScript from a flat per-opp row set, no drizzle subquery alias plumbing needed' },
    ],
  },
  {
    version: '1.131.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Fix: Team-of-Teams Rollup was returning HTTP 500 (empty diagnostics box, no server info) — the diagnostic activitiesInScope queries added in v1.129 were inline `await` expressions in the response literal, which throw as an unhandled exception if the DB query fails. Now pre-computed outside the response with per-query try/catch, and the whole endpoint is wrapped in a top-level try/catch that returns error + stack trace inside meta.diagnostics instead of a bare 500' },
    ],
  },
  {
    version: '1.130.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'Team-of-Teams Rollup: Diagnostics expander is now rendered unconditionally with an amber highlighted border when the dashboard is empty, dumps the entire response.meta (including diagnostics if present) plus any error string, and stays open by default. Fixes the previous version that only rendered when meta.diagnostics was non-null and blended in with the empty-state gray' },
    ],
  },
  {
    version: '1.129.0',
    date: '2026-07-23',
    highlights: [
      { category: 'security', text: 'Fix: canEdit on notes is now owner-only. Previously any App Admin caller got canEdit=true on every note, so Solutions Engineering (an App Admin) saw the full Edit / Delete / Private toolbar on Eric Garlepp\'s notes. Now buttons only enable for the note\'s original author. App Admins can still see every note (including private) but can\'t mutate through the UI' },
      { category: 'fix', text: 'Fix: Team-of-Teams Rollup Diagnostics expander is now emitted on every response path — previously the "no accessible teams" branch dropped the meta.diagnostics entirely, so the expander never rendered when scope was empty. Expander is now open by default and dumps the full JSON so it\'s obvious at a glance whether scope resolved, teams returned rows, and activities matched. Response also carries callerIsAppAdmin, totalTeams, activeTeams, requested and accessible team ids, and activitiesInScope counts (all-time and submitted) so we can pin down which filter is dropping the rows' },
    ],
  },
  {
    version: '1.128.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'My Notes: on other users\' notes, Edit / Delete / Private / AI Organize / Push to Salesforce are now visible-but-disabled (grayed out) instead of hidden — layout stays consistent between own and read-only notes. Copy stays enabled so you can pull the text into your own note' },
      { category: 'improvement', text: 'My Notes list sidebar: notes owned by other users now show a persistent user-lock icon on the right (replaces the Push / Delete hover actions on read-only rows) with a "belongs to <name>" tooltip' },
      { category: 'improvement', text: 'Team-of-Teams Rollup empty state now surfaces a Diagnostics expander with scopeSize, teamRowsCount, rawRowCount, and the resolved time window — so when the dashboard still reads empty despite visible data, we can see immediately whether the caller\'s team scope resolved, whether the teams table returned rows, and whether any activities matched' },
    ],
  },
  {
    version: '1.127.0',
    date: '2026-07-23',
    highlights: [
      { category: 'feature', text: 'My Notes: new "Show all users notes" icon toggle next to the search input — widens the query to every note on activities the caller has team access to. State persists in localStorage. Notes cluster by owner last name when the toggle is on so peers group together' },
      { category: 'feature', text: 'My Notes: new Private (lock) toggle next to Edit / Delete / Copy on every note the caller owns. Private notes are visible only to the creator and to App Admins; team peers and team admins never see them. Default off' },
      { category: 'improvement', text: 'User Management: user identity now splits into First name + Last name fields (User row on the edit form becomes two cells). Server stores users.first_name / last_name; displayName is auto-composed as "First Last" so every downstream renderer stays in sync. Migration 0084 backfills first_name / last_name by splitting existing display_name on the first space' },
    ],
  },
  {
    version: '1.126.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Team-of-Teams Rollup no longer renders blank when a user has only subteam membership: team scope now unions team_members AND subteam_users → subteams.team_id, so a user on a subteam gets their parent team in scope for cross-team dashboards' },
      { category: 'improvement', text: 'Rollup response now includes subteamsByTeam breakdown; expand a team row with the chevron to see per-subteam hours / cost / activities / contributors / opps. Users with no subteam roll up under an "Unassigned" bucket per team. Hours split evenly across a user\'s subteams so parent totals stay equal to the sum of children' },
      { category: 'improvement', text: 'New DashboardEmptyState component with a reason-aware message (no_data / no_accessible_teams / no_products). Manager Rollup uses it directly; TeamHeatmap / AccountBurn / ActivityBreakdown had hardcoded English empty states — now go through the localized leader.empty key. The base copy was rewritten in all six locales to explain that drafts and unapproved Outlook meetings don\'t count' },
    ],
  },
  {
    version: '1.125.0',
    date: '2026-07-23',
    highlights: [
      { category: 'fix', text: 'Dark mode fix: Outlook calendar off-hours cells are now visibly darker than working hours (was near-invisible with dark:bg-gray-900/60 on top of the dark base — switched to dark:bg-black/40)' },
      { category: 'fix', text: 'Dark mode fix: Team Heatmap zero-hours cells now use readable text (previously inherited the table body color, making "—" and "PTO" render as near-black text)' },
      { category: 'improvement', text: 'Estimated vs Logged dashboard: typical duration now persists on team_activity_types.typical_duration_minutes as the primary source (was only on sf_event_type_config which many teams never populated). Existing rows in sf_event_type_config keep working as a fallback. Migration 0083 adds the column' },
      { category: 'feature', text: 'Nudges per-locale: new nudge_rule_translations table with an admin editor (language dropdown + textarea + save) on each rule row. Server picks the row matching the caller\'s locale and falls back to the base message_template when unset. Client passes i18n.language to /api/nudges' },
    ],
  },
  {
    version: '1.124.0',
    date: '2026-07-23',
    highlights: [
      { category: 'improvement', text: 'i18n sweep across ActivityCard + ActivityForm + SuggestedActivityCard: 52 keys × 6 locales. Fixes the "Meeting owner / Assigned Oppty SE / Attendees / Products / Location / Event description" strings that stayed in English on all non-en locales because either the key was missing entirely (fell back to the t() defaultValue) or the shell existed with untranslated English text. All six locales now hold real translations' },
    ],
  },
  {
    version: '1.123.0',
    date: '2026-07-22',
    highlights: [
      { category: 'fix', text: 'Fix: SfRelationshipHelp popover no longer gets clipped by the Account modal\'s overflow container (rendered via portal with fixed positioning) and no longer inherits uppercase/tracking from the section label it sits inside. The help icon also gets a spot next to the Log Activity drawer\'s Salesforce link label so the same explanation is one click away wherever a user picks Campaigns / Leads' },
      { category: 'improvement', text: 'Localization audit: added the missing forgot_password + reset_password + sf_relationship + backup-codes-file + weekly aria-label namespaces to en (they were never keyed) and full Spanish translations to es. Fixed the last few hardcoded English strings on WeeklyView, ResetPassword and Login (resize handles, MFA backup-codes download file, password complexity error). Other locales fall back cleanly' },
    ],
  },
  {
    version: '1.122.0',
    date: '2026-07-22',
    highlights: [
      { category: 'feature', text: 'Account drill-down modal has a new Direct / Include All toggle in the top-right (defaults to Direct, unchanged behavior). Include All widens the timeline + summaries to also cover Opportunities under this Account, Campaigns tied to those Opps (via Opportunity.CampaignId), and Leads converted to this Account (via Lead.ConvertedAccountId)' },
      { category: 'feature', text: 'New "By Relationship" breakdown card renders in Include All mode with icons + count / hours / % per SF object type. Empty buckets are hidden — only what\'s actually connected shows' },
      { category: 'improvement', text: 'Shared SfRelationshipHelp popover documents the exact SF rules. Same component surfaces on the Log Activity SfSearch\'s Campaign / Lead tabs so the definitions stay consistent app-wide' },
    ],
  },
  {
    version: '1.121.0',
    date: '2026-07-22',
    highlights: [
      { category: 'improvement', text: 'Extends the v1.120 drift guard to the two remaining direct-write SF paths: PATCH /opportunities/:id/assigned-se and PATCH /opportunities/:id/field. Both now return 409 errors.salesforce.not_connected_write when SF isn\'t connected (was silently caching or 401-ing before), so the client can render a reconnect nudge instead of the write silently going nowhere. Async writeback paths (activity create/update, notes push) are unchanged — they retry-when-SF-reconnects and drift is already visible via the sync-status badge' },
    ],
  },
  {
    version: '1.120.0',
    date: '2026-07-22',
    highlights: [
      { category: 'fix', text: 'Fix: delete now refuses when Salesforce isn\'t connected instead of silently orphaning the SF Event/Task. The server returns 409 with errors.salesforce.not_connected_delete so the delete drawer shows a clear "reconnect first" message and leaves the local activity intact. SF-side failures likewise abort the delete (502) — no more drift between ImpactIQ and Salesforce. Callers can still opt out with ?force=1 when the SF record is genuinely gone.' },
    ],
  },
  {
    version: '1.119.0',
    date: '2026-07-22',
    highlights: [
      { category: 'fix', text: 'Fix: Account line on the activity card now renders as a clickable link even for legacy activities that have sfAccountName but no sfAccountId (approved before v1.117 wired AccountId through the save payload). ActivityCard now fires the live SF Opp→Account lookup whenever sfAccountId is null (not only when accountName is missing), then lazy-backfills the id onto the activity so subsequent reads render without another SF round-trip' },
    ],
  },
  {
    version: '1.118.0',
    date: '2026-07-22',
    highlights: [
      { category: 'fix', text: 'Fix: after Approve, Approve-with-template, or the drawer\'s Save & Approve, the Suggested card for that Outlook event now disappears and the right-side calendar re-syncs — no more stale "not approved" duplicate + missing calendar link until page refresh' },
      { category: 'fix', text: 'Fix: deleting (unapproving) an activity now re-syncs the calendar column so the Outlook meeting comes back as a Suggested card in-place' },
      { category: 'improvement', text: 'Every mutation path (approve, save, delete, refresh Outlook) now flows through a single reloadAll() that refetches activities + suggestions + calendar together, so the two columns can\'t drift out of sync' },
    ],
  },
  {
    version: '1.117.0',
    date: '2026-07-22',
    highlights: [
      { category: 'improvement', text: 'Forgot-password and Reset-password pages now share the branded login shell (gradient background, globe watermark, theme + language + help chips, centered brand logo, version stamp). New AuthShell component wraps all three pre-auth pages so the app stays visually consistent behind the modal' },
      { category: 'improvement', text: 'Activity cards now render the Account as a clickable link even when the activity was created via an Opportunity pick. Root cause: SfSearch\'s Opportunity results didn\'t carry the parent AccountId, so ActivityForm saved sfAccountId as null. Now AccountId flows through /search/opportunities → SfSearch.extra.accountId → payload → activities.sfAccountId' },
      { category: 'improvement', text: 'Outlook-suggested cards now stamp the Opportunity\'s parent Account when the user approves, so activities created from Outlook meetings get the same clickable Account link. Migration 0082 adds suggested_sf_opportunity_account_id/name on outlook_events; sync stamps them; approve() writes them onto the activity' },
      { category: 'fix', text: 'Dashboard → Account/Opportunity burn "Includes Opps" now correctly rolls up Opportunity activities under their parent Account using the sfAccountId snapshot on the activity itself (no more silently dropping Opps when sf_object_owner_cache is empty). Each Account row is expandable to show a per-Opportunity breakdown — collapsed by default, click the chevron to expand. Hours are counted once per activity: an activity is either direct-to-Account or under one Opportunity, never both' },
    ],
  },
  {
    version: '1.116.0',
    date: '2026-07-22',
    highlights: [
      { category: 'feature', text: 'Forgot-password flow: link on the sign-in page → /forgot-password (email entry) → email with one-shot reset link → /reset-password (new password form). Tokens expire in 60 minutes, are stored as sha256(token), and are consumed on first use. Server responds neutrally to /forgot-password so an attacker can\'t enumerate users; Okta / SSO-only accounts are silently skipped' },
      { category: 'security', text: 'Password reset invalidates every active session for the user so the next sign-in must re-run both password and MFA. Migration 0081 adds password_reset_tokens + seeds the password_reset email rule' },
      { category: 'improvement', text: 'Email preview: tenant logo now falls through to the org brand palette logo when the active theme doesn\'t have one uploaded. Same logic already applied to the theme /active endpoint; now applied consistently in email rendering so the preview and sent email match' },
    ],
  },
  {
    version: '1.115.0',
    date: '2026-07-21',
    highlights: [
      { category: 'feature', text: 'Email Communications editor now renders a live HTML preview iframe alongside the subject + body fields — same theme wrap and token substitution used at send time, refreshed as you type (400ms debounce)' },
      { category: 'improvement', text: 'Removed the redundant in-page "Email Communications" title; the page header already shows it. Refresh sits on the right of the description' },
      { category: 'improvement', text: 'Admin sidebar widened to w-60 so "Email Communications" (bold when active) fits on one line' },
      { category: 'feature', text: 'Two new email rules seeded via migration 0080: welcome + invitation. Both have templates + tokens + Send Test' },
      { category: 'feature', text: 'User Management → Create user: new checkboxes "Send invitation email" (includes initial password, forces change on first sign-in) and "Send welcome email" (lighter announcement, no credentials). Server sendByRule() dispatches on create' },
      { category: 'improvement', text: 'Password reset (Forgot password on login page + one-shot token + MFA re-challenge) is v1.116' },
    ],
  },
  {
    version: '1.114.0',
    date: '2026-07-21',
    highlights: [
      { category: 'feature', text: 'Admin → Email Communications: per-rule template editor. Edit Subject + HTML body per rule with token hints ({{name}}, {{ip}}, {{weekLabel}}, {{message}}, …). Blank falls back to the built-in default; save persists as email_rules.subject_template / body_template' },
      { category: 'feature', text: 'Send test button on every rule fires a live email to the admin\'s own address using the current template + sample tokens — same rendering path production uses, so what admins see is what recipients see (template, top bar, logo, footer)' },
      { category: 'improvement', text: 'All 4 dispatch sites (login alert, weekly recap, daily digest, nudge email) now flow through a shared sendByRule(key, defaults, tokens) helper — token interpolation happens in one place, templates roll out per-rule' },
      { category: 'improvement', text: 'Layout: header description spans full width; Refresh moves to the header row so the copy no longer compresses against the button' },
    ],
  },
  {
    version: '1.113.0',
    date: '2026-07-21',
    highlights: [
      { category: 'feature', text: 'New Admin → Integrations → Email Communications page lists every outbound email code path (New sign-in alert, Weekly recap, Daily digest, Nudge email, Admin test, SMTP test) with Active/Inactive toggle. Disabling a rule tells the sender to skip the email leg without stopping the underlying trigger (login events still record, digest tick still runs, nudges still deliver in-app)' },
      { category: 'improvement', text: 'Backing table email_rules (migration 0079) seeded with all 6 rules. Server helper isEmailRuleActive(key) gates each sender with a 30s cache; PATCH invalidates so admins see the effect on the next dispatch' },
      { category: 'improvement', text: 'Wired the gate into loginDetection.notifyUserOfNewLogin, weekly-recap.sendWeeklyRecap, digest.tick, and the nudge sync path in routes/notifications.ts. Admin test send + SMTP test are always allowed (they are the diagnostic paths themselves)' },
      { category: 'improvement', text: 'Password reset / welcome / invitation email flows deferred to v1.114 — they need new token tables + login-page changes; scoping with the user next' },
    ],
  },
  {
    version: '1.112.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Email top bar: when the mark image can\'t load (external-sender blocking, unreachable base URL), the "broken image" glyph + underline artifact are suppressed. The cell now has font-size:0/line-height:0/color:transparent so alt text is invisible and Outlook\'s placeholder icon has no room to render. On trusted-sender orgs the real logo still shows' },
      { category: 'improvement', text: 'Nudge rule Also-send-by-email is now wired end-to-end: the engine propagates rule.send_email through NudgeNotification, and the notifications sync path calls sendEmailViaConfigured + audits the delivery as channel="email" on nudge_events. Toggling the checkbox in Admin → Nudge Rules now actually sends the email alongside the in-app card' },
    ],
  },
  {
    version: '1.111.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Admin → SF Field Mappings: rows now group by SF Object (Event / Task / Opportunity / etc.) with a collapsible header that shows the object name + field count. Only the first group opens by default; the rest collapse until clicked. Keeps the list scannable on orgs with 50+ mappings' },
    ],
  },
  {
    version: '1.110.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Replaced the v1.109 hand-drawn stand-in with the real ImpactIQ mark PNG at /public/impactiq-mark.png (256×256 with the sidebar\'s dark-rounded-square / I / magnifying-glass Q / blue-diamond-spark design). Emails now render the canonical mark' },
      { category: 'improvement', text: 'Added CLAUDE.md §20c "Brand assets" spelling out where the SVG lives (`src/client/public/logo-9-iq-spark-arcs.svg`) vs the PNG (`public/impactiq-mark.png`), which to use where (SVG in-browser, PNG for email + Outlook-safe surfaces), and the rule "never regenerate a placeholder — ask for the export"' },
    ],
  },
  {
    version: '1.109.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Email header mark switched to PNG at /public/impactiq-mark.png so Outlook Windows renders it (SVG rendered as broken horizontal dashes in v1.107 because Outlook only partially interprets inline SVG). Current file is a hand-drawn stand-in — replace with an exported PNG of the sidebar logo whenever available; no code change needed once dropped in' },
      { category: 'fix', text: 'Suppressed the stray underline that appeared below "ImpactIQ" in Outlook by setting alt="" on the mark img (avoids duplicated fallback text) and text-decoration:none on the wordmark td (prevents Outlook auto-decoration)' },
    ],
  },
  {
    version: '1.108.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Admin Salesforce Connection: clicking Test Connection now clears the "token is not working" banner immediately when the test succeeds. The health probe was cached for 60s and the status endpoint kept returning stale unhealthy=true even after a green SOQL test; the test route now pushes fresh health into the same cache, and the client reloads the status on success' },
    ],
  },
  {
    version: '1.107.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Email header mark now references the actual sidebar ImpactIQ logo (public/impactiq-mark.svg = copy of the client\'s logo-9-iq-spark-arcs.svg) instead of a hand-drawn 24×24 placeholder that never matched the real brand mark' },
      { category: 'fix', text: 'Fixed Dockerfile: production stage now COPY /app/public. Without this the /public/impactiq-mark.svg and /public/theme-logo/* routes returned 404 in production and Outlook showed a broken image where the mark should render' },
    ],
  },
  {
    version: '1.106.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Emails now render the theme logo + ImpactIQ mark as hosted HTTPS URLs — the same approach CriteriaIQ and n8n templates use. Admin sets a public app URL once (Admin → Themes → Email Template → Public app URL field, persisted via /api/admin/integrations/public-base-url); outbound emails then reference <img src="${baseUrl}/public/theme-logo/${themeId}/${variant}.png"> and <img src="${baseUrl}/public/impactiq-mark.png">. CID inline attachment stays as the fallback when no base URL is configured' },
      { category: 'feature', text: 'Added a public /public folder served by Express — dropped-in assets (logos, brand imagery) are reachable at ${baseUrl}/public/<filename>. Seeded /public/impactiq-mark.png (24×24) so the top bar can lead with a small brand mark alongside the ImpactIQ wordmark' },
      { category: 'feature', text: 'New dynamic route GET /public/theme-logo/:themeId/:variant.png that decodes the theme\'s data-URI logo from the DB and serves it as real image bytes with a 7-day cache — no need to re-upload files anywhere, existing uploads work as-is' },
    ],
  },
  {
    version: '1.105.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Activities POST now dedups by outlookEventId per user. Saving an Edit from a Suggested Outlook card no longer creates a second row alongside the one Approve created — the existing activity is updated in place. Returns { deduped: true } in meta so the client can distinguish (no client change needed today; the payload is opaque)' },
      { category: 'fix', text: 'Admin → Themes email preview: the tenant logo renders in the iframe again. v1.103 converted the logo to a CID inline attachment which the iframe can\'t resolve — the preview endpoint now passes mode:"preview" so the renderer keeps the original data URI for display while send mode still uses CID for Outlook compatibility' },
      { category: 'fix', text: 'Re-applied the v1.102 cleanups that the v1.103 stash-pop resolution clobbered: dropped the broken inline SVG ImpactIQ mark on the top bar and the "Hello NAME," greeting from the body' },
    ],
  },
  {
    version: '1.104.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Unified the SF-Opportunity seeding path so picking an Opp from the <AttendeeSuggestions> quick-pick panel now populates ACV, Opp Amount, Sales Stage, Forecast, and Close Date identically to picking from the SfSearch popover. Previously AttendeeSuggestions strip-typed the Opportunity payload (dropped Amount/CloseDate/ForecastCategoryName at the interface layer) and its onPick handler bypassed the form\'s seeding logic — so editing a suggested Outlook meeting and picking the same Opp left every snapshot field blank' },
    ],
  },
  {
    version: '1.103.0',
    date: '2026-07-21',
    highlights: [
      { category: 'fix', text: 'Email templates: tenant logos now render in Outlook (Windows desktop). Data-URI images are converted to inline CID attachments (multipart/related for SMTP, @microsoft.graph.fileAttachment with isInline=true for Graph). Same approach CriteriaIQ uses — Outlook always drops inline data:image/* sources, so CID is the portable path' },
      { category: 'fix', text: 'Admin → Activity Templates: New / Edit modal Activity type dropdown no longer shows duplicates when no team is picked (previously listed each type once per team). Switched to a custom picker that also renders the type\'s configured lucide icon + color dot next to each name' },
    ],
  },
  {
    version: '1.102.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Email templates: dropped the inline SVG ImpactIQ mark that Outlook (Windows desktop) rendered as an empty box, and replaced it with a plain-text wordmark on the top bar. Also removed the "Hello NAME," greeting since it was redundant with the subject and the tenant-branded top bar' },
      { category: 'improvement', text: 'Suggested-card Approve: the created activity now carries ACV, Opp Amount, Sales Stage, Forecast Category, Close Date, and Account snapshot. Previously the Approve path only wrote sfWhat, so opening the activity in Edit later showed a blank ACV and missing snapshot summary. New GET /api/salesforce/opportunities/:id/summary powers the seed' },
    ],
  },
  {
    version: '1.101.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Log Activity: product chips now show the product\'s uploaded icon inside the chip, matching pill rendering elsewhere in the app' },
      { category: 'improvement', text: 'Log Activity: ACV + Opp Amount now populate when picking an Opportunity from the "Suggested from attendees" section. Previously the attendee-based suggestions carried only Id/Name/Stage, so ACV stayed 0 and Opp Amount rendered as em-dash. The OpportunityContactRole SOQL now also selects Opportunity.Amount / CloseDate / ForecastCategoryName, and SfSearch passes them through as extras on the picked selection' },
    ],
  },
  {
    version: '1.100.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Activity cards: when the linked Opportunity\'s Account can\'t be resolved (SF disconnected, unhealthy, or read failed), the card now renders "Account: Not synced" instead of silently hiding the row. Keeps the Account/Opportunity alignment stable across cards' },
      { category: 'improvement', text: 'Suggested cards: new Project chip on Eval Work (and any activity type with a related_object_picker SF Extra). Fetches candidates from /api/salesforce/opportunities/:oppId/related once an Opportunity is picked, matching how the ActivityForm already handles Evaluation__c. Selection propagates into the approved activity as sfRelatedType/Id/Name' },
      { category: 'improvement', text: 'Suggested cards: chip row now leads with a "Suggestions:" label so the pick affordance is clear even when a chip is still empty' },
      { category: 'improvement', text: 'Suggested cards: Clear selection on Pick Account / Pick Opportunity now clears ONLY that chip (previously wiped both slots because the override state was shared). If the cleared chip was the user override, the override is also dropped so the next batch sync can repopulate' },
      { category: 'improvement', text: 'MFA verify: the "code_invalid" error message now shows a plain-English hint instead of the raw i18n key. Added backup_code_invalid + code_required alongside for completeness' },
    ],
  },
  {
    version: '1.99.0',
    date: '2026-07-21',
    highlights: [
      { category: 'improvement', text: 'Salesforce health probe: /auth/salesforce/status now pings SF\'s identity endpoint and returns a `healthy` flag. When the stored token no longer works (revoked, password reset, session killed), the top connections banner shows a red "Reconnect" prompt pointing at My Settings → Integrations. Previously the status only checked whether we had a token row, so users saw a green connection while cards silently rendered "Unassigned" and empty Accounts' },
      { category: 'improvement', text: 'Assigned SE endpoint on the card path picks the first non-null value across Assigned_SE__c, Primary_Engineer__c, Specialist_Engineer__c (already shipped in v1.98 — noting here alongside the health probe since they fix the same class of "why is it Unassigned" report)' },
    ],
  },
  {
    version: '1.98.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Activity cards: lazy backfill for pre-v1.97 rows — when the card resolves the Opportunity\'s Account or Assigned SE via live SF, the resolved value is now PATCHed back onto the activity so subsequent renders skip the SF hop. Older rows silently fall through when the current user isn\'t the owner' },
      { category: 'improvement', text: 'Assigned SE: server now falls through Assigned_SE__c → Primary_Engineer__c → Specialist_Engineer__c so orgs that populate the concept under a different picklist stop showing "Unassigned" on the card' },
      { category: 'improvement', text: 'PossibleMatchChip Refresh (Pick Account / Pick Opportunity): recompute now bypasses the 24h TTL so a previous empty-candidate result doesn\'t stay pinned when the user hits Refresh — the batch sync path still honours the TTL' },
      { category: 'improvement', text: 'Product pills in New Template + Admin New Template modals now render the product\'s uploaded icon left of the name, matching the pills across the rest of the app' },
    ],
  },
  {
    version: '1.97.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Admin → Nudge Rules: rules now collapse to the header row by default (v1.96 accidentally pre-expanded the first two). Every row is a single click to open' },
      { category: 'improvement', text: 'Admin → Activity Templates: New Template + Edit modal now mirrors the user-facing New Template form. Activity type, activity title, default notes, default effort, location mode (Remote / On-site), and product pills all render alongside the admin-only target user + target team pickers so both surfaces produce identical rows' },
      { category: 'improvement', text: 'Activity cards: linked Opportunity\'s Account renders left of the Opportunity line even when the live SF read fails or the user isn\'t connected. Account name is now snapshotted onto the activity on save (from the SF Link picker\'s embedded accountName). Migration 0078 adds sf_account_id, sf_account_name, sf_assigned_se_name' },
      { category: 'improvement', text: 'Activity cards: Assigned Oppty SE now displays the value that was written when the activity was saved, instead of relying on a live SF picklist read that was intermittently returning "Unassigned". A future resync can refresh the cached value; the persisted snapshot is the display source of truth' },
    ],
  },
  {
    version: '1.96.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Admin → Themes: Brand Palette now also renders a solid "Default" badge when no named theme is active, so the currently-effective default is unambiguous from either row' },
      { category: 'improvement', text: 'Admin → Activity Templates: added inline Edit + a top-right "New Template" button. Both open the same modal (name, title template, notes, default effort, target user, target team) so admins can create or reassign templates without leaving the console' },
      { category: 'improvement', text: 'Admin → Nudge Rules: rules collapse to a compact header row by default; the first two are pre-expanded and any row toggles open/closed on click. Long lists stay scannable' },
      { category: 'improvement', text: 'Admin → Nudge Rules: new per-rule "Also send by email" checkbox delivers the nudge through the team\'s active theme email template alongside the in-app card. Off by default; migration 0077 adds the column' },
    ],
  },
  {
    version: '1.95.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Product icon upload now saves correctly. Root cause: the global express.json({ limit: "256kb" }) rejected the ~1.33 MB base64 payload of a 1 MB PNG. Admin routes now accept up to 8 MB, matching the documented per-icon max' },
      { category: 'fix', text: 'Salesforce Link picker: "Suggested from attendees" no longer disappears a few seconds after the popover opens. The state-clearing useEffect gated on !open was wiping fetched suggestions on any parent re-render; now only the render gates on open' },
      { category: 'improvement', text: 'Admin → Themes: the currently-active theme now shows a solid "Default" badge (amber Star) instead of a re-clickable "Set as Default" button. Removes the confusion of "did it save?" when the theme was already the default' },
      { category: 'improvement', text: 'Admin → Activity Templates: Clone now opens a modal with a target-user picker + team picker + new-name field so admins can assign an existing template to another owner or team, not just re-clone to the original owner' },
      { category: 'improvement', text: 'Team-name pills across Admin (Capacity Groups, Cost Groups, Activity Templates) now lead with a Building2 icon, matching the icon-before-label convention' },
    ],
  },
  {
    version: '1.94.0',
    date: '2026-07-20',
    highlights: [
      { category: 'feature', text: 'Salesforce Link picker on the Log Activity form now shows a "Suggested from attendees" section above the search input when the popover opens with no query typed. Powered by a new GET /api/salesforce/search/from-attendees that runs findSuggestionsForEmails against the current attendee emails and returns Accounts + Opportunities. Clicking a suggestion sets the SF Link without any typing' },
      { category: 'improvement', text: 'Brand Palette section now has Apply + Set as Default buttons alongside Edit + Clone. Set as Default POSTs /admin/themes/deactivate-all so the palette becomes the app-wide default (no theme is_active). Fixes the "there are no buttons on that theme" gap' },
      { category: 'improvement', text: 'User Management edit form: removed the redundant "App Admin" checkbox. The Role dropdown\'s Admin option has been the authoritative source since v1.81 (auto-syncs users.is_app_admin), and the checkbox created ambiguity — users showed as "Admin" while is_app_admin stayed false. Kept the Default Admin toggle as a distinct concept' },
      { category: 'improvement', text: 'Migration 0076 backfills is_app_admin=true for any user who already holds team_members.role=\'admin\' on at least one team but drifted from the v1.81 sync (rows created before that release or via the demo generator). Fixes the "another admin doesn\'t see themes" report' },
    ],
  },
  {
    version: '1.93.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Approve-with-template dropdown on suggested cards now renders each template with a leading Bookmark icon, matching the rest of the app\'s icon-before-label convention' },
      { category: 'feature', text: 'Admin → Activity Templates: new cross-user Templates page (app-admin only) lists every saved template with owner + team + timestamps, with Delete + Clone actions. Editing individual template fields still lives on the owner\'s own /api/templates so audit trails stay clean' },
      { category: 'fix', text: 'Admin → Products: fixes the empty-list bug for admins on the second team. The endpoint used to hard-gate on requireAppAdmin (blanket 403 for team_admin), now accepts team_admin too and filters to products linked to teams they admin. App admins still see the full list' },
      { category: 'feature', text: 'Products can now carry an uploaded icon (PNG / SVG / BMP, max 1 MB). Icon renders left of the product name on product pills across the app (ActivityCard row, Suggested-card chips, admin edit form). Backed by migration 0075 + POST/PATCH /admin/products' },
    ],
  },
  {
    version: '1.92.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Empty-day activity list now reads "No activities logged this day." instead of "this week."' },
      { category: 'improvement', text: 'Theme editor email preview auto-refreshes as color pickers / footer text / logo variant change (400ms debounce). Previously the iframe was only fetched once on mount, so the preview looked empty until the user saved the theme' },
      { category: 'improvement', text: 'Brand Palette row (read-only view) now shows only color swatches + logo thumbs — no hex-code text next to each of ~30 swatches. Matches how individual theme rows have always been rendered' },
      { category: 'fix', text: 'Outlook rehydrate on Suggested-card Edit: fixes the STILL-blank Meeting owner / Attendees / Event description bug. WeeklyView\'s onEdit handler for Suggested cards was dropping descriptionBody / meetingOwner / attendees when building the prefill payload — only 5 fields were forwarded. Now spreads the full payload so ActivityForm sees the Outlook context the card already displays' },
      { category: 'improvement', text: 'Creating a new template from the Activities-page New Template modal now broadcasts a "templates-changed" event; every SuggestedActivityCard re-fetches /api/templates so Approve-with-Template appears immediately without a page reload' },
    ],
  },
  {
    version: '1.91.1',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Activities page → New Activity Template modal: fixes "Invalid input: expected number, received string" on the effortHoursDefault field. The <Input type="number"> still delivers a string; the modal now parses to Number (or null) before POST, matching the server\'s Zod schema and the parent form on My Settings → Templates' },
    ],
  },
  {
    version: '1.91.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Outlook edit rehydrate: fixes Meeting owner / Attendees / Event description staying blank on Edit. Root cause was ActivityForm\'s populate effect missing `weekEvents` in its deps — when Edit opened before /api/outlook/calendar resolved, the fallback ran against `undefined` and never re-ran when data landed. Deps + rehydrate guard fix it' },
      { category: 'fix', text: 'Theme New Theme save button: fixes Save being disabled + spinning from the moment the form opens. `saving === editingId` collapsed to `null === null === true` in create mode; now guarded by `editingId !== null`' },
      { category: 'feature', text: 'New Refresh from Outlook icon button on the Activities header (left of Templates). Client-throttled to 1 refresh per 10 minutes with a per-minute countdown in the tooltip; backed by POST /api/outlook/refresh which reuses syncUserCalendar(force:true)' },
      { category: 'improvement', text: 'Approve on Suggested cards now confirms when no product is picked and the user hasn\'t explicitly opted-in to "None". Cancel returns to the card, OK approves without product' },
      { category: 'feature', text: 'SF Account + Opportunity possible-match chips on Suggested cards. Cached on outlook_events (migration 0074) via a single batched Contact+OpportunityContactRole SOQL inside syncUserCalendar (zero SF calls on poll). 24h TTL. Chip dropdown shows top candidates from attendee emails; Refresh icon re-runs the match for that event only (server-throttled 10s). Selecting a candidate persists via PATCH /suggestions/:id/override and flows into the activity\'s sfWhatId on Approve' },
    ],
  },
  {
    version: '1.90.0',
    date: '2026-07-20',
    highlights: [
      { category: 'feature', text: 'Dashboard: new Subteam filter to the left of Team Member. When a subteam is picked, the member dropdown restricts to that subteam\'s members. Backed by new /api/teams/:teamId/subteams and /:teamId/subteams/:subteamId/members endpoints' },
      { category: 'improvement', text: 'This Week Capacity widget now shows "X.Xh / Y.Yh (Z%)" — logged over total capacity — where the target already factors in the user\'s work-week hours minus PTO and holidays. Excluded-hours breakdown visible in the tooltip' },
      { category: 'fix', text: 'Outlook meeting details on Edit: fixes blank Meeting owner / Attendees / Event description on activities opened via the Suggested-card Edit button (edit() now carries descriptionBody / meetingOwner / attendees into the form). The Edit form also falls back to the currently-loaded Outlook event when the activity has an outlookEventId but stored fields are blank — covers legacy rows' },
      { category: 'improvement', text: '/api/activities list now returns outlookEventId so the client can cross-reference the loaded calendar view' },
    ],
  },
  {
    version: '1.89.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Theme create: fixes the "Save" button hanging with a spinner. The client now merges HARD_DEFAULTS + palette + form colors before submit (so any color field missing from the current state passes server Zod), surfaces error messages inline, and always clears the saving state in a finally block. Label under the input is now "Theme name" (was "Team Name")' },
      { category: 'improvement', text: 'Theme edit/create Cancel now reverts previewed CSS custom properties to the org-active theme by re-fetching /api/themes/active. Previously canceling out of a preview left the app stuck on the previewed colors' },
      { category: 'improvement', text: 'Email template header now embeds the real ImpactIQ sidebar logo (public/logo-9-iq-spark-arcs.svg) inlined as a data URI at 28px, replacing the placeholder magnifier icon' },
      { category: 'improvement', text: 'Deferred to a follow-up PR: Dashboard subteam dropdown, This Week Capacity total vs logged (PTO + holidays + user hours), Outlook meeting-details prefill for owner / description / attendees on activity edit' },
    ],
  },
  {
    version: '1.88.0',
    date: '2026-07-20',
    highlights: [
      { category: 'feature', text: 'Per-team active theme: new teams.active_theme_id (migration 0073). Team Management → Theme section lets admins pick which theme members of that team see when they log in. Empty = inherit the org-wide default. /api/themes/active honors the caller\'s default team' },
      { category: 'improvement', text: 'Activity template modal on the Activities page now includes product chips (matches My Settings → Templates)' },
      { category: 'improvement', text: 'Brand Palette now has a Clone button that seeds a new theme from the palette (colors + logos + email settings). Combines with the per-team picker: clone → tweak → assign to a team' },
      { category: 'improvement', text: 'Email template header now renders a small SVG mark before the "ImpactIQ" wordmark (inline data URI so email clients don\'t block it)' },
    ],
  },
  {
    version: '1.87.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Admin → Themes → Brand Palette: the Email Template panel now appears here too. Fields set here become the org-wide default that every theme inherits when its per-theme email fields are null — three-tier fallback (theme → palette → hardcoded)' },
      { category: 'feature', text: 'New Copy button on each theme row in Admin → Themes clones the theme (name gets a "(copy)" suffix, clone starts inactive, colors + logos + email settings all carried over). Backed by POST /api/admin/themes/:id/clone' },
      { category: 'improvement', text: 'Follow-up scoped separately: per-team active themes + Team Management theme picker + investigating logos-not-showing on the theme edit form' },
    ],
  },
  {
    version: '1.86.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'My Settings → Templates: the Activity Type dropdown now renders each type with its admin-configured icon (or color dot fallback) alongside the name. Replaces the native <select> which couldn\'t show SVGs, so the icons admins set in Admin → Activity Types were being swallowed on this form' },
      { category: 'improvement', text: 'Activities page: the Templates chip is now always visible next to Log Activity (previously hidden when the user had zero templates). Menu now leads with a "New template…" item that opens a modal with the primary template fields; saved templates immediately appear both in the dropdown and in My Settings → Templates, since both surfaces read /api/templates' },
    ],
  },
  {
    version: '1.85.0',
    date: '2026-07-20',
    highlights: [
      { category: 'feature', text: 'System-default email template: every outbound email (nudges, weekly recaps, admin tests, password resets, everything routed through sendEmailViaConfigured) now ships wrapped in a branded shell — 960px content column, 51px top and bottom bars, ImpactIQ mark on the header left, tenant logo on the header right, "Hello {name}," greeting, "Generated by ImpactIQ · <date>" on the footer right. Plain-text mirror auto-generated for text/plain fallback' },
      { category: 'feature', text: 'Admin → Themes: new Email Template panel per theme with top/bottom bar color pickers, footer-left text field, and a checkbox picker to choose which of the theme\'s two uploaded logos (light or dark) is embedded in the email header. Bar text color is auto-picked (near-white vs near-black) from the bar background so it always stays legible' },
      { category: 'feature', text: 'Live email preview inside the Themes editor: renders the exact HTML the recipient would see in a sandboxed iframe, refreshable from the form. Backed by POST /api/admin/themes/email-preview' },
      { category: 'improvement', text: 'Backed by migration 0072 (four new nullable columns on app_themes). Nulls fall back to the system default (indigo top + slate bottom) so themes that pre-date this release still render valid emails' },
    ],
  },
  {
    version: '1.84.0',
    date: '2026-07-20',
    highlights: [
      { category: 'fix', text: 'Outlook connect: fixes AADSTS50011 "redirect URI does not match" on HTTPS deployments. The redirect_uri sent to Microsoft is now derived from the incoming request\'s scheme + host (honoring X-Forwarded-Proto), so a TLS-terminating proxy in front of the app no longer causes the app to advertise http:// while Azure has https:// registered. Applies to both the authorize URL and the code-exchange call — they must match exactly' },
      { category: 'fix', text: 'Express bootstrap: app.set(\'trust proxy\', true) so req.protocol reflects the outer scheme' },
    ],
  },
  {
    version: '1.83.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Role Management matrix now covers every Admin section: Activities Import, Cost Groups, Holiday Calendars, Products, Slack, Audit Log, Login History, Sync Issues, Sync History, Nudge History, and Demo Data all gain their own checkbox rows next to the existing entries' },
      { category: 'security', text: 'APP_ADMIN_ONLY slimmed to a security floor (Teams + Role Management only). Every other admin section is now controlled by the matrix, so a team_admin granted admin.integrations, admin.audit_log, etc. actually sees those sections. Previously the hard-coded list overrode the matrix and hid these from everyone except the App Admin' },
    ],
  },
  {
    version: '1.82.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations → Microsoft Graph: new Redirect URI readout under Tenant ID. Shows the exact `<APP_URL>/auth/microsoft/callback` string admins need to paste into the Entra app registration\'s Authentication → Web platform → Redirect URIs, with a one-click Copy button. Unblocks AADSTS500113 "No reply address is registered" without leaving the app' },
      { category: 'security', text: 'Role Management: the admin.* checkboxes now actually gate the Admin sidebar for non-App-Admin roles. Previously Admin.tsx filtered purely on the hard-coded APP_ADMIN_ONLY list, so unchecking `admin.activity_types` (or any other admin.* page) had no effect. Now the section filter reads role_permissions via hasPermission() for team_admin/leader/contributor, with APP_ADMIN_ONLY still acting as the app-admin-only floor' },
    ],
  },
  {
    version: '1.81.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'User Management → Role dropdown: setting a user to **Admin** now grants full App Admin rights (parity with the primary Admin) by syncing users.is_app_admin. Previously the option only made them a team-scoped admin, which is why newly-promoted users kept logging in with the "Team Admin" label and reduced menus' },
      { category: 'improvement', text: 'The role→app_admin sync is bi-directional: demoting an Admin to any other role revokes is_app_admin, unless they still hold role=admin on another team or are the default admin. Applied at create, PATCH .../role, and add-to-team endpoints so every entry path stays consistent' },
    ],
  },
  {
    version: '1.80.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'My Settings → My Connections: Salesforce and Outlook cards now backfill the "Connected as {username/UPN}" line on load for connections that pre-date v1.78. First load hits SF identity / Graph /me once, persists to user_integrations.account_label, subsequent loads are instant' },
      { category: 'improvement', text: 'Connected / Not connected pills now lead with a CheckCircle2 / CircleSlash icon per the icon-before-label convention' },
    ],
  },
  {
    version: '1.79.0',
    date: '2026-07-20',
    highlights: [
      { category: 'security', text: 'Security: first-login password reset is now enforced server-side. Users flagged with must_change_password can no longer bypass the "Set Your Password" screen by refreshing — requireAuth returns HTTP 428 on every API path except /auth/change-password until the password is actually reset' },
      { category: 'improvement', text: 'Client detects mustChangePassword on /auth/me and routes to the change-password step on load, so a refresh mid-first-login keeps the user on the required screen' },
      { category: 'fix', text: 'Admin → Integrations → Email → Test connection no longer probes /users/{mailbox}: that endpoint requires User.Read.All, which apps scoped to Mail.Send only (or locked to a mailbox via Application Access Policy) don\'t have. The test now confirms token acquisition + scopes and defers the mailbox verification to the Send Test Email button — matches how CriteriaIQ works with the same creds' },
    ],
  },
  {
    version: '1.78.0',
    date: '2026-07-20',
    highlights: [
      { category: 'improvement', text: 'My Settings → My Connections: Salesforce and Outlook cards now show "Connected as {username/UPN}" so users can tell at a glance which SF org user / mailbox is wired up' },
      { category: 'improvement', text: 'account_label captured at OAuth callback time (SF identity URL for Salesforce, Graph /me for Microsoft) and stored on user_integrations. Populated for existing connections on next reconnect' },
    ],
  },
  {
    version: '1.77.1',
    date: '2026-07-17',
    highlights: [
      { category: 'fix', text: 'First-login password change: the "Set Your Password & Continue" screen now forwards the CSRF token on POST /auth/change-password. Fixes the "errors.csrf_missing" wall that blocked users on their very first login' },
    ],
  },
  {
    version: '1.77.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations → Email Configuration: Save no longer auto-closes the panel. A green "Saved" chip surfaces on success and the panel stays put so admins can immediately verify + send a test email' },
      { category: 'improvement', text: 'Client Secret / SMTP password fields now omit themselves from the save payload when left blank, so first-time saves no longer trip the "required" guard and existing-secret rows are updated correctly' },
      { category: 'feature', text: 'New Send Test Email input on the Email Configuration panel: admins enter a recipient address and click Send test → the system uses the currently-saved SMTP or Graph credentials to actually deliver a test email. Result (success or SF error) surfaces inline. Backed by POST /api/admin/integrations/email/send-test' },
    ],
  },
  {
    version: '1.76.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'My Settings currency picker uses the same SingleSelect chip as the Dashboard\'s "Show Costs In" — with currency symbol + code + name, and "no rate" annotation for currencies missing FX data' },
      { category: 'feature', text: 'User Management → edit user: new Display Currency dropdown (defaults to USD) admins can set per user. Kept in sync with the user\'s own My Settings picker — both paths write to users.preferred_currency, so admin and user changes align automatically' },
      { category: 'improvement', text: '/auth/me now returns preferredCurrency so client-side money formatters can honor the choice without a separate round-trip' },
    ],
  },
  {
    version: '1.75.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Activity page top row: the "N meetings" and "N approved" chips collapse to icon + count only; the full label surfaces on hover' },
      { category: 'feature', text: 'New Weekly Revenue Impact chip next to Hours: sums the ACV of every unique Opportunity touched this week (each Opp counted once regardless of activity count), converts USD → the user\'s preferred currency via the latest FX rate. Tooltip shows the rate and its as-of date' },
      { category: 'feature', text: 'My Settings → Hourly Cost Rate card: new "Show costs in" currency picker. Choice is stored per user and drives the Weekly Revenue chip today; more money displays will honor it as they land. Backed by migration 0070 (users.preferred_currency)' },
    ],
  },
  {
    version: '1.74.3',
    date: '2026-07-17',
    highlights: [
      { category: 'fix', text: 'SF Activities modal: clicking the backdrop to close the window no longer bubbles the click to the underlying activity card, so the card\'s Edit drawer stops opening as a side effect of closing the Opportunity / Account / Evaluation view' },
    ],
  },
  {
    version: '1.74.2',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Activity card SF chip order: Account now renders before Opportunity (Account → Opportunity → Evaluation). The leading "·" separator before the Account icon is gone so the row reads clean' },
    ],
  },
  {
    version: '1.74.1',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Sidebar order: My Settings now sits below My Notes and above Admin (Activities → Dashboard → My Notes → My Settings → Admin)' },
    ],
  },
  {
    version: '1.74.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Activity card SF Related chip: restyled to match the Opportunity / Account chip — plain gray "Label:" prefix + blue link name with the Target icon, no more bordered pill. Chip click now stopPropagation so the SF Activities modal opens without also opening the edit drawer underneath' },
      { category: 'improvement', text: 'SF Activities modal: header now shows the admin-configured Display Label ("Evaluations") instead of the raw "SF.RELATED" whatType tag when opened from an Evaluation-style chip. The chip resolves the label from the type\'s SF Extras and passes it through' },
      { category: 'improvement', text: 'Admin → Activity Types → Salesforce Extras: existing rows can now be edited in place. New Pencil icon on each row loads the config back into the form; Save PATCHes the row instead of creating a duplicate. Cancel returns to the empty state cleanly' },
    ],
  },
  {
    version: '1.73.0',
    date: '2026-07-17',
    highlights: [
      { category: 'fix', text: 'Admin Salesforce Reconnect now honors the admin\'s previously-connected instance URL (mirrors the user-side fix from v1.65.2). Fixes the case where clicking Reconnect kicked admins over to test.salesforce.com instead of their own org, then failed the OAuth code exchange' },
      { category: 'improvement', text: 'Admin Salesforce Connection now live-probes the stored token (cheap User describe) and surfaces an amber "token is not working — SF-backed dropdowns will silently return empty" banner with a one-click Reconnect. Health result is cached 60s so a page load isn\'t a hammer' },
    ],
  },
  {
    version: '1.72.0',
    date: '2026-07-17',
    highlights: [
      { category: 'fix', text: 'Activity save now persists the SF Related picker selection: POST /api/activities and PATCH /:id include sf_related_type / sf_related_id / sf_related_name — fixes the Evaluation picker on Eval Work silently dropping the choice on save' },
      { category: 'improvement', text: 'Activity card SF Related chip: swapped the GraduationCap icon for Target and now shows the admin-configured Display Label from the activity type\'s SF Extras row (e.g. "Evaluations: Evaluation Test") next to the record name. Falls back to a humanized sobject name when no extras label is set. Chip is still clickable to open the SF Activities modal filtered by relatedId. Extras are fetched once per activity type and cached module-scoped so a busy week doesn\'t balloon into N requests' },
    ],
  },
  {
    version: '1.71.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Weekly view toolbar: five icon buttons now sit flush next to each other in the Weekly Capacity row — Show Non-Activities (moved from the top row, now icon-only with hover label), Sort direction, Expand All, Collapse All, Compact Approved. Every toggle persists across refresh and login/logout via localStorage' },
      { category: 'improvement', text: 'Outlook calendar Show Weekends toggle: state now persists between sessions' },
      { category: 'improvement', text: 'New from template: header button converted to a blue Bookmark icon-only chip; the templates list shows a Bookmark icon before each entry. The Log Activity drawer\'s template picker gets a matching Bookmark icon in the label and inside the select' },
      { category: 'feature', text: 'SF Field Mappings: new "Write a fixed value (constant) to Salesforce on save" checkbox on both Add and inline edit — any mapping can now opt into constant-value mode without changing the App Field to (Constant value). Checking reveals the type-aware constant input; unchecking clears it on save' },
    ],
  },
  {
    version: '1.70.1',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Activity form Opp field extra: falls back to inferring fieldType from the actual SF value when the config was saved without one — fixes existing RFP Request rows that were showing "false" as text instead of a real checkbox' },
      { category: 'improvement', text: 'SF Field Mappings — legacy constant rows: the type-aware constant value input now also appears for any mapping that already has a constantValue (e.g. the seeded activity_status_completed rows), not only when the app field is "(Constant value)". Save handler preserves the constant regardless of appField' },
      { category: 'improvement', text: 'SF Field Mappings — SF API Field picker: the giant multi-row list no longer auto-expands on Add. It stays collapsed until the admin focuses the search input' },
      { category: 'improvement', text: 'SF Extras Related picker: the "Parent Field on Child (Opportunity ref)" label is now clearer — "SF Field (Opportunity lookup on the child)" — with a hint explaining what it does and that the dropdown only lists reference fields on the chosen child sobject' },
    ],
  },
  {
    version: '1.70.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'SF Mappings — type-aware constant value: when the app field is (Constant value) and the SF field describe returns its type, the constant input now renders as a checkbox (boolean), picklist dropdown (fetched from SF), number, date, or datetime as appropriate. Admins can no longer accidentally save "true"/"false" strings into checkbox fields' },
      { category: 'improvement', text: 'Admin → Activity Types list: rows with SF Extras configured now display a PlugZap icon next to the SF Object column with a tooltip counting attached extras' },
      { category: 'improvement', text: 'SF Extras Opp field: fieldType and mode are now persisted with sensible defaults (boolean + read) even when the admin never touches the Select, fixing existing checkbox extras that were rendering "false" as text on the Activity form' },
      { category: 'improvement', text: 'SF Extras related picker: after picking the Child SF Object, labelField auto-defaults to Name (or first non-Id field) once SF describe returns the child\'s fields — no more empty picker on the Activity form' },
      { category: 'improvement', text: 'SF Extras related picker: new Mode selector (Read / Write / Read+Write). Read is functional today; Write / Read+Write are UI-ready for follow-up write-back wiring' },
      { category: 'improvement', text: 'Salesforce Extras description text updated to reflect the read/write, type-aware, and searchable-picker capabilities' },
    ],
  },
  {
    version: '1.69.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Admin → Activity Types → Salesforce Extras: SObject and field pickers are now live SF datalist-searchable inputs (same pattern as SF Field Mappings) — type to filter, alphabetical, no more copy-pasting API names. Two new SF endpoints back this: /api/salesforce/sobjects and /api/salesforce/sobjects/:sobject/fields' },
      { category: 'feature', text: 'Salesforce Extras — Opportunity field: new "Mode" toggle (Read-only vs Read/write). In read/write mode SEs can toggle the checkbox or type into text/number fields and the value writes back to Salesforce via a new PATCH /api/salesforce/opportunities/:id/field endpoint. Amber warning surfaces when the picked SF field isn\'t updateable' },
      { category: 'improvement', text: 'Salesforce Extras section is now rendered INSIDE the Activity Type edit card, directly above the Save / Cancel row. + Opp field and + Related picker buttons get leading Plus icons; extras editor Save/Cancel get leading Save/X icons' },
    ],
  },
  {
    version: '1.68.1',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Admin → Integrations: every integration pill (Okta, Salesforce, Microsoft Graph, Azure OpenAI, Email) now leads with a CheckCircle2 (configured) or AlertCircle (not configured) icon; the Configure button gets a Settings glyph. Matches the Admin Salesforce Connection styling' },
      { category: 'improvement', text: 'Activity form Salesforce Extras: fetch errors are now surfaced inline instead of silently returning null, so admins can see when the endpoint is broken (e.g. migration 0069 hasn\'t landed) versus when there are simply no extras configured for a type' },
    ],
  },
  {
    version: '1.68.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Activity cards: SF Related chip (Evaluation__c / future child-object pickers) now renders as a clickable button next to the Opp/Account chip. Clicking opens the SF Activities modal filtered by sf_related_id so SEs can see every activity logged against the same eval' },
      { category: 'feature', text: 'Admin → Integrations → Admin Salesforce Connection: new Reconnect button (RefreshCw) that re-runs the admin OAuth flow. Disconnect button gets a LogOut icon; the Connected / Not configured pill gets a leading CheckCircle2 / AlertCircle' },
      { category: 'improvement', text: 'CLAUDE.md: new "Icon-before-label" convention (§19c) — every user-facing pill, badge, or labeled button must lead with a lucide glyph. Search for existing pairings before inventing a new one, and never ship a label-only chip' },
    ],
  },
  {
    version: '1.67.0',
    date: '2026-07-17',
    highlights: [
      { category: 'feature', text: 'Activity form: per-activity-type Salesforce Extras — extra SF context surfaced under the Salesforce Link when a specific type is chosen. Two kinds: read-only Opportunity field readout (e.g. RFP_Request__c on RFx Work) and a picker for related SF records under the linked Opp (e.g. Evaluation__c on Eval Work). Selection is stored on activities.sf_related_* so it also filters the SF Activities modal' },
      { category: 'feature', text: 'Admin → Activity Types: new "Salesforce Extras" section directly under each type\'s edit form. Add / remove either kind of extra with SF API-name inputs; discoverable next to where the type is defined' },
    ],
  },
  {
    version: '1.66.0',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Settings → Holiday calendars: card now shows the team-inherited calendars (with "From team: X" chips) when the user has no personal override. Fixes the empty "No calendars available" state for users whose team has calendars assigned in Admin → Calendars → Team Assignments' },
      { category: 'improvement', text: 'Admin → Team Management: the team edit form is now organized into distinct sections (Identity, People & Salesforce, Notifications, Work Week Defaults, Subteams) with panel borders and hint subtitles so settings feel like independent concerns instead of a wall of inputs' },
    ],
  },
  {
    version: '1.65.2',
    date: '2026-07-17',
    highlights: [
      { category: 'improvement', text: 'Salesforce Reconnect from Settings: the OAuth flow now honors the user\'s previously connected org host (their stored instance URL) instead of the tenant-wide fallback. Fixes the case where the tenant config pointed at test.salesforce.com but the user\'s org was prod (or vice-versa) — reconnect landed on the wrong environment and couldn\'t exchange the code' },
    ],
  },
  {
    version: '1.65.1',
    date: '2026-07-16',
    highlights: [
      { category: 'fix', text: 'Notes viewer dark mode: paragraph/list/table body text was still rendering near-black on the dark surface because Tailwind\'s dark: variant on the outer wrapper wasn\'t reaching ReactMarkdown\'s children. .md-body now sets a real gray-200 color on .dark and forces child elements to inherit' },
    ],
  },
  {
    version: '1.65.0',
    date: '2026-07-16',
    highlights: [
      { category: 'fix', text: 'My Notes viewer: dark-mode markdown rendering — headings, inline code, code blocks, tables, hr, and blockquote all get proper dark-mode contrast so notes stop rendering as near-black text on near-black background' },
      { category: 'feature', text: 'Nudges — final batch (multi-condition): every rule can carry an optional AND/OR combinator on top of its base trigger. Shape: {op, clauses:[{triggerType,config}]}. Admin edits as raw JSON on the rule row' },
      { category: 'feature', text: 'Nudges — final batch (leader roll-up): new "Leader roll-up threshold" field. When set, the rule fires for team leaders/admins if N or more distinct members of the team received an in-app nudge of the same trigger in the last 7 days. {count} token substitutes the actual number' },
    ],
  },
  {
    version: '1.64.0',
    date: '2026-07-16',
    highlights: [
      { category: 'feature', text: 'Nudges Batch C — Slack delivery: new "Slack Incoming Webhook" field in Team Management. When set, every in-app nudge for a member of the team also posts a compact severity-colored card to Slack. Best-effort; failures logged and swallowed so Slack outages never block in-app delivery' },
      { category: 'feature', text: 'Nudges Batch C — Admin dry-run: every rule row now has a Preview button that evaluates the rule against every team member right now and lists exactly who would receive it (with the rendered message)' },
      { category: 'improvement', text: 'Nudge History: Slack deliveries land as separate rows with channel=slack so admins can audit both channels side-by-side' },
    ],
  },
  {
    version: '1.63.0',
    date: '2026-07-16',
    highlights: [
      { category: 'improvement', text: 'Sync History header: Re-sync is now an icon-only button with the label moved to the hover tooltip so the row stays uncluttered' },
      { category: 'feature', text: 'Nudges Batch B — per-user snooze: each in-app nudge card now has a bell-off menu with 1 / 7 / 30 day snooze options; the muted rule stops firing for the caller until the window expires' },
      { category: 'feature', text: 'Nudges Batch B — per-rule cooldown: new "Cooldown (hours)" field on every rule; the engine consults nudge_events for last delivery and short-circuits if inside the window (prevents same-nudge-every-poll spam)' },
    ],
  },
  {
    version: '1.62.1',
    date: '2026-07-16',
    highlights: [
      { category: 'improvement', text: 'Admin → Nudge Rules: status chip now has a leading CheckCircle (active) / CircleSlash (inactive) icon, and the Disable/Enable button carries a matching PowerOff/Power glyph so the row state reads at a glance' },
    ],
  },
  {
    version: '1.62.0',
    date: '2026-07-16',
    highlights: [
      { category: 'feature', text: 'Settings → Work & Notifications: new "Team" card shows your main team + every subteam you belong to, with role and kind chips, hierarchically laid out' },
      { category: 'feature', text: 'Nudge rules: new severity (info / warning / critical) drives notification card border color + icon; admins can pick a per-rule lucide icon' },
      { category: 'improvement', text: 'Nudge templates: rich tokens {user_name}, {team_name}, {count}, {stage_name} now substitute across every trigger type (existing {opp_name} / {account_name} / {days} continue to work)' },
    ],
  },
  {
    version: '1.61.1',
    date: '2026-07-16',
    highlights: [
      { category: 'feature', text: 'Delete activity: new "Delete notes related to activity" checkbox in the confirm dialog — hard-deletes rows in activity_notes for that activity when ticked (unchecked keeps notes intact so history survives)' },
      { category: 'improvement', text: 'My Notes: full i18n coverage — page title, subtitle, search placeholder, all bucket labels, sort/group toggles, viewer, chat, AI Organize/Link, MEDDPICC, and Push-to-Salesforce modal now translate in de/fr/es/pt/it/ja' },
      { category: 'improvement', text: 'Sidebar nav: "My Notes" label now translates in all 7 locales (was falling back to English defaultValue)' },
    ],
  },
  {
    version: '1.61.0',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Nudge engine: stage_no_type trigger no longer fires on brand-new opps — it now requires the opp\'s earliest activity to be older than the configured window before flagging a missing follow-up type' },
      { category: 'improvement', text: 'Nudge engine: per-rule try/catch so one misconfigured rule (missing product, empty capacity group) no longer blocks the whole team\'s nudge stream (fixes the "Some nudges couldn\'t sync" bell warning)' },
      { category: 'feature', text: 'New Admin → Monitoring & Audit → Nudge History page: cross-tenant table of every nudge delivered to a user, filterable by trigger and free-text, retained 30 days' },
    ],
  },
  {
    version: '1.60.6',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'EventRelation persistence fix: WhoId is now written as null on re-sync when the activity has no explicit sfWhoId, clearing any legacy WhoId that survived from a previous version. That removes the auto-created IsInvitee=false EventRelation and lets the explicit IsInvitee=true write land. Also reverted the existing-row skip to catch any prior EventRelation, so subsequent syncs stop hitting DUPLICATE_VALUE' },
      { category: 'feature', text: 'Log Activity drawer: red Trash icon top-right on existing activities. Confirmation modal requires typing "delete"; on confirm we delete the linked Salesforce Event/Task first, then archive the ImpactIQ row' },
    ],
  },
  {
    version: '1.60.5',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'External attendees now consistently show under Meeting Digest → Outside Your Organization: WhoId is no longer auto-picked from attendees. Every matched Contact/Lead/User goes through EventRelation IsInvitee=true. Explicit sfWhoId picks still land on the record when set' },
    ],
  },
  {
    version: '1.60.4',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'SF sync: Activity Type (Type field) now writes even when the team has no sf_event_type_config seeded — the activity type name is passed through and let SF validate against its picklist' },
      { category: 'feature', text: 'Sync History tab now has a Re-sync button that flips the activity back to pending and kicks the writeback worker (owner or app admin)' },
      { category: 'improvement', text: 'ACV: locked whenever a linked Opportunity has a known Amount OR the activity has synced — the input reflects the SF-side value' },
      { category: 'improvement', text: 'Team Management → Subteams: Kind dropdown gains Leader and Product options alongside Region / Type / Other' },
    ],
  },
  {
    version: '1.60.3',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Assigned SE: fixed for Picklist-typed Assigned_SE__c fields — the picker now loads the SF picklist values verbatim (via describe) and writes back the picklist value string. The initial-value read no longer references a nonexistent Assigned_SE__r.Name relationship' },
    ],
  },
  {
    version: '1.60.2',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'EventRelation: only skip attendees that already have an IsInvitee=true row. SF auto-creates an IsInvitee=false row when WhoId is set — that no longer blocks us from writing the explicit invitee row that surfaces the person in the Meeting Digest "Outside Your Organization" section' },
      { category: 'improvement', text: 'Assigned SE picker now pulls active Salesforce Users filtered by Department=PSE (live SOQL). Falls back to the cached user list if Salesforce isn\'t reachable' },
    ],
  },
  {
    version: '1.60.1',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Fix duplicate Salesforce Events: kickSync (fire-and-forget) and the periodic worker could both grab the same pending activity and each create a Salesforce Event. Added an in-memory dedup lock so only one process syncs an activity at a time' },
      { category: 'improvement', text: 'Log Activity: dropped the "Syncs to the linked Opportunity as Total_Acv__c…" hint under ACV. ACV field is now locked (grayed) once the activity has synced to Salesforce — edits after that don\'t push, so the input reflects it' },
    ],
  },
  {
    version: '1.60.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Log Activity: confirm-on-close guard — if you\'ve edited the form and try to close, you\'re prompted to save as draft, discard, or keep editing' },
      { category: 'improvement', text: 'Salesforce Link: placeholder now says "Search Opportunities, Accounts, Campaigns, or Leads…"' },
      { category: 'improvement', text: 'Salesforce search results now show Owner and Close Date alongside Stage' },
      { category: 'improvement', text: 'On Opportunity pick, the ACV auto-fills from the Opp Amount and Sales Stage / Forecast Category / Close Date are snapshotted onto the activity for historical reporting (migration 0063 adds sales_stage, forecast_category, opp_amount, opp_close_date)' },
    ],
  },
  {
    version: '1.59.3',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Work Week: dropped the hardcoded "full-time = 5 days & 45 hours" rule. Full-time is now a classification label; expected weekly hours are authoritative in Capacity Groups (per user or per team). The "at least one work day" and "end after start" checks remain' },
    ],
  },
  {
    version: '1.59.2',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Team Manager picker now searches Salesforce Users (preferred) and app users side-by-side. Picking a SF user resolves to the linked ImpactIQ user via User Management\'s Linked SF User — if no ImpactIQ account is linked, the picker warns instead of silently failing' },
    ],
  },
  {
    version: '1.59.1',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Team Management: fix subteam Add — the nested form was submitting the outer team form and refreshing the page; Add now uses a button/click handler and the subteam is created without wiping the edit form' },
      { category: 'improvement', text: 'Team Management: Linked Salesforce Department suggestions are hidden until you click into the search input (previously always visible under the search box)' },
    ],
  },
  {
    version: '1.59.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Team Management: new Subteams section per team — add / rename / activate / delete subteams (Region, Type, or free-form Kind). Each subteam supports assignable Leaders picked from app users' },
      { category: 'feature', text: 'Team Management: teams get an optional Team Manager pointing at an app user (nullable, single)' },
      { category: 'feature', text: 'User Management: users can pick which subteams they belong to (multi-select, auto-saves)' },
    ],
  },
  {
    version: '1.58.1',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Sync History: rows expand to show the raw payload JSON, activity title links to the activity (opens the edit drawer on the Activities page), and the table paginates 20 per page' },
    ],
  },
  {
    version: '1.58.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Admin → Monitoring & Audit → new Sync History page shows every Salesforce write-back attempt across the tenant, with filters (Status, Search) and sortable columns (User, Activity, Attempted)' },
      { category: 'improvement', text: '5-day retention is now enforced globally by a 6-hourly cull job so the audit table stays small even for activities that never resync' },
    ],
  },
  {
    version: '1.57.9',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Event Name field (WhoId) now auto-fills from the first attendee that matches a Salesforce Contact (falling back to Lead) when the user hasn\'t explicitly picked a Who. The Event card now shows a Name — EventRelation rows continue to feed the invitees section' },
    ],
  },
  {
    version: '1.57.8',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Attendee sync: skip the Event owner when adding invitees — Salesforce rejects EventRelation rows where RelationId == OwnerId ("You cannot add the owner of the event as an invitee"). Fixes the Attendee sync failure on activities where the meeting organizer was also an attendee' },
    ],
  },
  {
    version: '1.57.7',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Admin SF Connection: new Test Connection button runs a live SOQL round-trip against the stored admin token' },
      { category: 'fix', text: 'User Management: Refresh from Salesforce no longer 500s when the cache upsert fails; sf-details endpoint returns partial data instead of surfacing a naked 500' },
      { category: 'improvement', text: 'Sync Issues: EventRelation (attendee → Name) failures now flip the parent activity to Failed so Admin → Sync Issues surfaces them with the SF error message' },
    ],
  },
  {
    version: '1.57.6',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings: SF API Field column is wider and keeps the constant chip on the same line as the API name' },
    ],
  },
  {
    version: '1.57.5',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'User Management: Title (SF) now populates for users linked before the Title cache column existed — the endpoint refreshes stale cache rows from Salesforce on demand' },
      { category: 'improvement', text: 'User Management: reworded the Cost Groups hint under the SF chips' },
    ],
  },
  {
    version: '1.57.4',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Weekly view: the "Outlook calendar is not configured" empty state is now a compact icon + one-line message instead of a 16-unit-tall centered block' },
    ],
  },
  {
    version: '1.57.3',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Sync History now logs the EventRelation (attendee → Name) sync as its own row with a diagnostic payload — you can see how many attendee emails matched Contacts / Leads / Users, which were created, and which failed. Silent failures are gone' },
    ],
  },
  {
    version: '1.57.2',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'User Management: when a user is linked to a Salesforce User, their SF Title and SF Manager now appear below the picker (pulled from Salesforce and cached)' },
    ],
  },
  {
    version: '1.57.1',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Timezone: seeded from Salesforce when Outlook is not yet connected. Connecting Outlook later switches the app timezone to Outlook and surfaces a one-time banner in Settings so you can flip back to Salesforce if you prefer' },
      { category: 'improvement', text: 'Attendee sync: SF Users are now matched alongside Contacts and Leads, so an internal co-worker with a Salesforce login appears in the Event Name section too' },
    ],
  },
  {
    version: '1.57.0',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Settings → Time zone: shows your Outlook and Salesforce timezones side by side; pick either as the app default. Defaults to Outlook when connected, otherwise Salesforce' },
      { category: 'improvement', text: 'Settings → Connections: the Reconnect button now has an icon so all three buttons (Connect / Reconnect / Disconnect) match' },
    ],
  },
  {
    version: '1.56.1',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Open in Salesforce icon now shows up on synced activities — the activities list endpoint was omitting sfRecordId from its response, so the client never saw it' },
    ],
  },
  {
    version: '1.56.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Multi-attendee sync: each attendee with an email is resolved to a Salesforce Contact (or Lead if no matching Contact) and linked to the SF Event via EventRelation, so every synced meeting shows all invitees in the Name section' },
      { category: 'improvement', text: 'Activity_Status__c = "Completed" is now seeded as a global constant mapping (Event + Task) — every synced activity carries that value automatically' },
    ],
  },
  {
    version: '1.55.3',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Meeting Owner picker now searches Salesforce Contacts AND Users in parallel, grouped in the dropdown so you can pick either' },
      { category: 'improvement', text: 'Description sync: Meeting Owner is prepended as a one-line header (Meeting Owner = First Last) so reviewers see the organizer in Salesforce even though SF has no native field for it' },
      { category: 'fix', text: 'Description body from the Outlook meeting invite now actually writes to the mapped SF Description field (previously the writeback ignored the description mapping)' },
    ],
  },
  {
    version: '1.55.2',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'SF sync fix: standard mappings (WhatId, Subject, Type, ActivityDateTime, EndDateTime, DurationInMinutes, Description, Location, OwnerId) that shipped as read-only are flipped to read/write — Related To, Description, Type, and Duration now actually push to Salesforce' },
      { category: 'feature', text: 'Activity cards get a new Open in Salesforce icon (link-2) next to the notes button — visible once the activity has synced; opens the SF Lightning record in a new tab' },
    ],
  },
  {
    version: '1.55.1',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Meeting Owner: Salesforce Contact search is now global — no need to link an Opportunity or Account first. Picking a contact fills the owner and auto-appends them to attendees' },
    ],
  },
  {
    version: '1.55.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Salesforce sync audit: every write-back attempt is now recorded (success/failure, operation, SF record id, error, and payload). New Sync History tab in the Edit Activity drawer shows the last 5 days.' },
      { category: 'improvement', text: 'Weekly view now auto-refreshes every 8s while any activity is still Pending, so "Syncing to Salesforce…" clears without a manual reload' },
    ],
  },
  {
    version: '1.54.5',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Log Activity: Attendees field now respects Enter and semicolons — you can freely add new lines and multiple names without them collapsing' },
      { category: 'improvement', text: 'Log Activity: Meeting Owner supports Salesforce Contact search when the activity is linked to an Opportunity or Account' },
    ],
  },
  {
    version: '1.54.4',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'Log Activity: changing Effort Hours now pushes the End Time to Start + hours, so a 1-hour activity actually spans one hour on the calendar' },
      { category: 'improvement', text: 'New activity default end time is +1 hour from start (was equal to start)' },
    ],
  },
  {
    version: '1.54.3',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Team Management: SF Department picker in the edit form — search Salesforce, click to link, Refresh from Salesforce for latest values' },
    ],
  },
  {
    version: '1.54.2',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Fix white screen / React #310 when clicking Edit on an SF Field Mapping (hooks-order violation)' },
    ],
  },
  {
    version: '1.54.1',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings edit form: SF Object is now editable (switching Event → Opportunity now reveals the target object\'s fields in the search)' },
    ],
  },
  {
    version: '1.54.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'Team Management: link a team to a Salesforce Department; chip renders next to the Deactivate button once set' },
      { category: 'improvement', text: 'Team Management: Deactivate button gets a power icon + a confirmation prompt' },
      { category: 'feature', text: 'Sticky Connections banner reminds signed-in users to hook up Salesforce and Outlook (dismissible per session)' },
      { category: 'improvement', text: 'My Notes: page header spacing matches other pages (no extra padding around the top bar)' },
    ],
  },
  {
    version: '1.53.4',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings: once a field is picked the browsing list collapses; the selection shows as a compact chip next to the search box' },
    ],
  },
  {
    version: '1.53.3',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'SF Field Mappings: field picker actually expands to 10 rows now (the shared Select was force-shrinking it)' },
    ],
  },
  {
    version: '1.53.2',
    date: '2026-07-15',
    highlights: [
      { category: 'improvement', text: 'SF Field Mappings: the SF API Field picker now shows at least 10 rows so long field lists are easier to scan' },
    ],
  },
  {
    version: '1.53.1',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'User Management: new "Linked SF User" column shows each user\'s linked Salesforce account at a glance' },
    ],
  },
  {
    version: '1.53.0',
    date: '2026-07-15',
    highlights: [
      { category: 'feature', text: 'User Management: link an ImpactIQ user to a specific Salesforce User via a searchable picker (with a Refresh from Salesforce button)' },
      { category: 'improvement', text: 'SF Field Mappings: field dropdown is now alphabetized and searchable in both Add and Edit' },
      { category: 'improvement', text: 'SF Field Mappings: Edit form now exposes Direction and Active — full parity with Add' },
    ],
  },
  {
    version: '1.52.4',
    date: '2026-07-15',
    highlights: [
      { category: 'fix', text: 'Salesforce OAuth: token exchange now normalizes .lightning.force.com Login URLs to the correct API host (fixes "unsupported_grant_type" after successful authorize)' },
    ],
  },
  {
    version: '1.52.3',
    date: '2026-07-15',
    highlights: [
      { category: 'security', text: 'Salesforce OAuth now uses PKCE (fixes "missing required code challenge" error on Connected Apps that require it)' },
      { category: 'improvement', text: 'Stub SF data is off once the tenant Admin has configured Salesforce — no more fake stub-001 results' },
      { category: 'improvement', text: 'Admin SF Field Mappings picker falls back to the caller\'s SF connection when the admin OAuth flow hasn\'t been completed' },
    ],
  },
  {
    version: '1.52.2',
    date: '2026-07-14',
    highlights: [
      { category: 'improvement', text: 'My Notes: Expand All / Collapse All icon buttons added to the toolbar (same icons as Activities)' },
      { category: 'improvement', text: 'My Notes: icon buttons in the toolbar sit flush against each other' },
      { category: 'fix', text: 'Fixed name sort in Organize-by-Account: Accounts and their Opportunities now flip A→Z / Z→A correctly' },
    ],
  },
  {
    version: '1.52.1',
    date: '2026-07-14',
    highlights: [
      { category: 'improvement', text: 'My Notes: SF entity buckets (Acme Renewal, Hotel Co…) are now collapsible individually' },
      { category: 'feature', text: 'Organize-by-Account toggle: roll Opportunities up under their parent Account' },
      { category: 'feature', text: 'Icon-buttons for date sort (newest/oldest) and bucket name sort (A→Z / Z→A) with persisted preferences' },
      { category: 'improvement', text: 'Search now covers Opportunity / Account / Campaign / Lead names in addition to note body' },
      { category: 'improvement', text: 'Ask My Notes: All notes / This note toggle now has icons' },
    ],
  },
  {
    version: '1.52.0',
    date: '2026-07-14',
    highlights: [
      { category: 'feature', text: 'My Notes redesigned as a split-pane explorer: dense grouped list on the left, reading canvas on the right' },
      { category: 'feature', text: 'Notes now carry MEDDPICC tags (Metrics, Champion, Pain, …) — chips in the viewer let you attach body text or free-form values' },
      { category: 'feature', text: 'AI Organize rewrites a note as clean structured Markdown via GPT-4o (preview + apply, non-destructive)' },
      { category: 'feature', text: 'AI Link Suggestions finds Salesforce Opps / Accounts / Campaigns matching an unlinked note' },
      { category: 'feature', text: 'Ask My Notes: chat interface that answers questions across your notes with citations' },
    ],
  },
  {
    version: '1.51.0',
    date: '2026-07-14',
    highlights: [
      { category: 'feature', text: 'Per-day sort toggle on the activities list (descending default; earliest at top)' },
      { category: 'fix', text: 'Suggested activity card and edit drawer now agree on activity type (the drawer no longer re-classifies)' },
    ],
  },
  {
    version: '1.50.5',
    date: '2026-07-14',
    highlights: [
      { category: 'fix', text: 'Outlook calendar chips now paint in the user\'s timezone (position + label agree)' },
      { category: 'fix', text: 'Events near midnight now bucket into the correct day column' },
    ],
  },
  {
    version: '1.50.4',
    date: '2026-07-14',
    highlights: [
      { category: 'fix', text: 'Activity card: Campaign-linked activities now show the megaphone icon (was falling back to the Account building)' },
      { category: 'improvement', text: 'Activity card: Lead / Contact links render with the SF icon + label + name, matching the Opp/Account/Campaign row' },
    ],
  },
  {
    version: '1.50.3',
    date: '2026-07-14',
    highlights: [
      { category: 'improvement', text: 'My Notes: Linked To dropdown shows an icon next to each SF-object option' },
      { category: 'improvement', text: 'My Notes: note rows now carry the activity-type color tint + left border' },
      { category: 'improvement', text: 'Markdown in notes now renders with bold/italic/lists/code/links styled' },
      { category: 'fix', text: 'Suggested activity, calendar panel, and SF activities modal now honour the user timezone (fixes the 11:00 AM vs 3:00 PM mismatch)' },
      { category: 'improvement', text: 'Editing Start Time in the edit drawer shifts End Time by the same amount so effort hours stay put' },
    ],
  },
  {
    version: '1.50.2',
    date: '2026-07-14',
    highlights: [
      { category: 'fix', text: 'Activity card and edit drawer now render times in the signed-in user\'s timezone (matching the list view)' },
      { category: 'fix', text: 'Linking an activity to a Campaign no longer drops the link or creates a duplicate SF Event/Task' },
      { category: 'fix', text: 'SF write-back updates the existing Event/Task on re-sync instead of creating a duplicate' },
      { category: 'improvement', text: 'Submit button reads "Submit and Approve Activity" on create and "Submit and Update Activity" on edit' },
    ],
  },
  {
    version: '1.50.1',
    date: '2026-07-14',
    highlights: [
      { category: 'improvement', text: 'Edit Activity drawer no longer shows a Notes field — use the notes icon on the card' },
      { category: 'improvement', text: 'Compact toggle is now a two-state icon button with a pressed state' },
      { category: 'fix', text: 'Closing the Notes drawer no longer opens the Edit Activity drawer underneath' },
    ],
  },
  {
    version: '1.50.0',
    date: '2026-07-14',
    highlights: [
      { category: 'feature', text: 'New My Notes page in the sidebar: every note you have written across all activities in one place' },
      { category: 'feature', text: 'Filter by SF link type and push state, edit inline, bulk-select' },
      { category: 'feature', text: 'Push notes to Salesforce as a first-class ContentNote on the linked Opportunity or Account' },
      { category: 'feature', text: 'Push audit trail shows which record each note was published to and when' },
    ],
  },
  {
    version: '1.49.2',
    date: '2026-07-14',
    highlights: [
      { category: 'improvement', text: 'Notes icon now shows a pointer cursor on hover' },
      { category: 'fix', text: 'Adding a note no longer closes the Notes drawer' },
    ],
  },
  {
    version: '1.49.1',
    date: '2026-07-14',
    highlights: [
      { category: 'fix', text: 'Clicking inside the Notes drawer no longer opens the activity edit form' },
      { category: 'feature', text: 'Notes drawer adds two new scopes: By Campaign and By Lead' },
      { category: 'improvement', text: 'Scope tabs now have icons; a bold header shows what you are rolling up' },
      { category: 'improvement', text: 'By Account view labels each note with the Opportunity it came from' },
    ],
  },
  {
    version: '1.49.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Notes are now a first-class feature: notebook icon on each activity card opens a dedicated drawer' },
      { category: 'feature', text: 'Timestamped, authored, markdown-rendered notes with edit/delete for the author or admins' },
      { category: 'feature', text: 'Toggle across By Activity / By Opportunity / By Account rollups from inside the drawer' },
    ],
  },
  {
    version: '1.48.1',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Activities: new Compact toggle next to Expand/Collapse All collapses details below the Started/Ended line on approved cards; per-card chevron expands individually' },
    ],
  },
  {
    version: '1.48.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Salesforce Link picker gains a Campaign tab (searches by name + attendee-linked campaigns via CampaignMember)' },
      { category: 'improvement', text: 'Assigned Oppty SE now persists in dev/stub mode too, so the card reflects the picked value immediately' },
    ],
  },
  {
    version: '1.47.1',
    date: '2026-07-13',
    highlights: [
      { category: 'fix', text: 'Fix: clicking Account / Lead tabs no longer submits the drawer' },
      { category: 'improvement', text: 'Contact search moved out of the Salesforce Link picker and into Attendees (filtered by the linked Opp/Account)' },
      { category: 'fix', text: 'Assigned Oppty SE line on the activity card refreshes after saving the drawer' },
    ],
  },
  {
    version: '1.47.0',
    date: '2026-07-13',
    highlights: [
      { category: 'improvement', text: 'Opportunity-linked activities show Assigned Oppty SE under Meeting Owner' },
      { category: 'feature', text: 'Edit drawer: Assigned SE picker (searches SF users) writes back to Opportunity.Assigned_SE__c on save' },
    ],
  },
  {
    version: '1.46.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Link activities to Salesforce Contacts and Leads (writes to SF WhoId) alongside Opportunity/Account' },
      { category: 'feature', text: 'SF search drawer gains Contact and Lead tabs' },
      { category: 'improvement', text: 'Activity card shows a CON / LEAD badge for at-a-glance disambiguation of polymorphic lookups' },
    ],
  },
  {
    version: '1.45.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'SF Field Mappings: SF Object list now pulls live from Salesforce (describeGlobal) — map any SObject, not just Event/Task' },
      { category: 'feature', text: 'Per-mapping Direction toggle (Read only / Write only / Read & Write) — read-only mappings never write back to SF' },
      { category: 'improvement', text: 'Reference fields (OwnerId → User) are captured with a target hint for future dashboard traversal' },
      { category: 'feature', text: 'Activity Types edit form gains an Active checkbox so admins can deactivate a type without deleting it' },
    ],
  },
  {
    version: '1.44.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Activity Types: new Salesforce Picklist Value override lets many ImpactIQ types roll up to one SF value (Build out / Test / Architect → Eval Work)' },
      { category: 'improvement', text: 'Removed the redundant Salesforce Type Mapping page — everything now lives on Activity Types' },
      { category: 'improvement', text: 'Fallback Value hint now clarifies it only fires when the SF picklist deactivates the value' },
    ],
  },
  {
    version: '1.43.0',
    date: '2026-07-13',
    highlights: [
      { category: 'security', text: 'Sessions expire after 8 hours idle or 48 hours absolute; stale cookies auto-logout' },
      { category: 'security', text: 'MFA backup codes: remaining count shown on Login History and User Management; user is warned after each use' },
      { category: 'security', text: 'Backup codes depleted → account is locked pending admin MFA reset' },
      { category: 'security', text: 'Login History surfaces whether each session was minted via TOTP or a backup code' },
    ],
  },
  {
    version: '1.42.4',
    date: '2026-07-13',
    highlights: [
      { category: 'fix', text: 'Fix: Non-Activity marks now persist across reloads (missing migration entry left the table uncreated)' },
    ],
  },
  {
    version: '1.42.3',
    date: '2026-07-13',
    highlights: [
      { category: 'improvement', text: 'Non-Activity: Save Draft / Submit disabled in the edit drawer until Mark as Activity' },
      { category: 'improvement', text: 'Outlook event details show a Non-Activity banner and swap Log Activity for Mark as Activity' },
    ],
  },
  {
    version: '1.42.2',
    date: '2026-07-13',
    highlights: [
      { category: 'improvement', text: 'Non-Activity: product pills disabled with a tooltip explaining why' },
      { category: 'improvement', text: 'Edit drawer shows a Non-Activity banner with a Mark-as-Activity button' },
      { category: 'fix', text: 'Edit / Mark-as-Activity buttons stay readable on the gray card in light mode' },
    ],
  },
  {
    version: '1.42.1',
    date: '2026-07-13',
    highlights: [
      { category: 'improvement', text: 'Non-Activity meetings now render dark gray in the day list to match the Outlook calendar' },
      { category: 'improvement', text: 'Approve buttons are disabled on a Non-Activity card; type badge shows as "None"' },
      { category: 'improvement', text: 'Added an inactive "None" activity type to every team as the display anchor' },
    ],
  },
  {
    version: '1.42.0',
    date: '2026-07-13',
    highlights: [
      { category: 'feature', text: 'Mark a meeting as a Non-Activity to remove it from the day list and gray it out on the Outlook calendar' },
      { category: 'feature', text: '"Show Non-Activities" toggle next to Log Activity reveals hidden ones so you can restore them' },
    ],
  },
  {
    version: '1.41.2',
    date: '2026-07-13',
    highlights: [
      { category: 'security', text: 'Cleared 18 Dependabot alerts: pinned Vite / i18next / drizzle versions and overrode transitive esbuild to a patched release' },
    ],
  },
  {
    version: '1.41.1',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'Column-per-week dashboards (Heatmap, Capacity Trend, Logging Compliance) show a clear notice on All-time instead of an empty grid' },
    ],
  },
  {
    version: '1.41.0',
    date: '2026-07-11',
    highlights: [
      { category: 'feature', text: 'Account/Opportunity Burn: new "Accounts (includes Opps)" rollup toggle' },
    ],
  },
  {
    version: '1.40.3',
    date: '2026-07-11',
    highlights: [
      { category: 'feature', text: 'Dashboard range picker gains an "All" option after 12w' },
    ],
  },
  {
    version: '1.40.2',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'Scope chips on Account rows: "Includes Opps" vs "Direct only"' },
      { category: 'improvement', text: 'Drawer header shows the same chip so the semantics are always visible' },
    ],
  },
  {
    version: '1.40.1',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: "Account drill-in drawer now rolls up opportunity activities to match the dashboard totals" },
    ],
  },
  {
    version: '1.40.0',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'SF activities drawer: Filtered / All time toggle, defaults to dashboard range' },
      { category: 'fix', text: 'Sales Team Breakdown headers align with the centered numeric columns' },
    ],
  },
  {
    version: '1.39.3',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'Sales Team Breakdown: numeric columns center-aligned' },
      { category: 'improvement', text: 'Owner-level Open activities removed; use Account/Opp for the drawer' },
    ],
  },
  {
    version: '1.39.2',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'Sales Team Breakdown: consistent indentation across Member/Manager/Owner' },
      { category: 'improvement', text: 'Open activities on Account and Opp rows opens the timeline drawer' },
    ],
  },
  {
    version: '1.39.1',
    date: '2026-07-11',
    highlights: [
      { category: 'improvement', text: 'Bell nudges now sync across all teams the user belongs to' },
      { category: 'improvement', text: 'Sync errors surface as an amber banner instead of silent failure' },
    ],
  },
  {
    version: '1.39.0',
    date: '2026-07-11',
    highlights: [
      { category: 'feature', text: 'Sales Team Breakdown: new Member pivot with optional Manager grouping' },
      { category: 'improvement', text: 'Sales Team Breakdown + Manager Rollup tables gain sort, search, pagination' },
      { category: 'feature', text: 'Products Breakdown: segmented activity-type bars + per-member drill-down' },
      { category: 'improvement', text: 'Members column added to Manager and Owner pivots' },
    ],
  },
  {
    version: '1.38.3',
    date: '2026-07-10',
    highlights: [
      { category: 'improvement', text: 'Sales Team Breakdown: Account:/Oppty: prefixes, rep + opp counts' },
      { category: 'fix', text: 'Fix crash when toggling to Owner pivot' },
      { category: 'improvement', text: 'Manager/Owner toggle gets icons' },
    ],
  },
  {
    version: '1.38.2',
    date: '2026-07-10',
    highlights: [
      { category: 'fix', text: 'Team-of-teams rollup now populates for app admins with no team memberships' },
      { category: 'improvement', text: 'Sales Team Breakdown resolves demo Opportunities/Accounts via a local SF owner cache' },
    ],
  },
  {
    version: '1.38.1',
    date: '2026-07-10',
    highlights: [
      { category: 'improvement', text: 'Dashboard picker shows current category as prefix' },
      { category: 'improvement', text: 'Sales Team Alignment buttons gain icons' },
    ],
  },
  {
    version: '1.38.0',
    date: '2026-07-10',
    highlights: [
      { category: 'feature', text: 'Team-level work-week defaults' },
      { category: 'improvement', text: 'User create form pre-fills from team' },
      { category: 'improvement', text: 'Sidebar preset gradients: lighter top, darker bottom' },
    ],
  },
  {
    version: '1.37.1',
    date: '2026-07-10',
    highlights: [
      { category: 'fix', text: 'Dark-mode contrast fixes on admin tables' },
      { category: 'improvement', text: 'Changelog popover kept in sync with new releases' },
    ],
  },
  {
    version: '1.37.0',
    date: '2026-07-10',
    highlights: [
      { category: 'feature', text: 'Worker type on user create/edit' },
      { category: 'feature', text: 'Work-week changes now require admin approval' },
      { category: 'feature', text: 'Approvals panel in User Management' },
    ],
  },
  {
    version: '1.36.0',
    date: '2026-07-10',
    highlights: [
      { category: 'improvement', text: 'Native color picker removed — hex text + swatch instead' },
      { category: 'improvement', text: 'Extended theming to nav hover, user pill, header text' },
      { category: 'feature', text: '5 preset themes (Midnight Slate, Warm Neutral, Forest, Ocean, Sunset)' },
    ],
  },
  {
    version: '1.35.3',
    date: '2026-07-10',
    highlights: [
      { category: 'fix', text: 'Theming: removed live preview to eliminate picker freeze' },
      { category: 'improvement', text: 'Added explicit Preview button on theme editors' },
    ],
  },
  {
    version: '1.35.2',
    date: '2026-07-10',
    highlights: [
      { category: 'improvement', text: 'Theming: debounce color-picker apply + memoize inputs' },
    ],
  },
  {
    version: '1.35.1',
    date: '2026-07-10',
    highlights: [
      { category: 'improvement', text: 'Demo data seeds Sales Team Alignment' },
      { category: 'improvement', text: 'Role Management uses admin/dashboard categories' },
      { category: 'fix', text: 'Notification prefs no longer locked disabled' },
    ],
  },
  {
    version: '1.35.0',
    date: '2026-07-10',
    highlights: [
      { category: 'feature', text: 'Sales Team Alignment (admin)' },
      { category: 'feature', text: 'Sales Team Breakdown dashboard' },
      { category: 'feature', text: 'Async combobox with SF user cache' },
    ],
  },
  {
    version: '1.34.0',
    date: '2026-07-10',
    highlights: [
      { category: 'feature', text: 'Dashboard filter presets' },
      { category: 'feature', text: 'Anomaly badges on Team Heatmap' },
      { category: 'feature', text: 'Weekly recap email + in-app changelog' },
      { category: 'improvement', text: 'Cost per opp heat pill' },
    ],
  },
  {
    version: '1.33.0',
    date: '2026-06-30',
    highlights: [
      { category: 'improvement', text: 'Salesforce sync latency + batch retry' },
      { category: 'feature', text: 'Audit diff and team clone' },
    ],
  },
  {
    version: '1.32.0',
    date: '2026-06-20',
    highlights: [
      { category: 'feature', text: 'Weekly capacity bar' },
      { category: 'improvement', text: 'Chip system' },
      { category: 'improvement', text: 'Timezone confidence' },
    ],
  },
  {
    version: '1.31.1',
    date: '2026-06-15',
    highlights: [
      { category: 'improvement', text: 'Admin: group sidebar into non-clickable categories' },
    ],
  },
  {
    version: '1.31.0',
    date: '2026-06-12',
    highlights: [
      { category: 'improvement', text: 'Admin tables pagination / sort / search' },
      { category: 'improvement', text: 'Settings polish' },
    ],
  },
  {
    version: '1.30.3',
    date: '2026-06-08',
    highlights: [
      { category: 'fix', text: 'i18n: full EN parity across all locales' },
    ],
  },
  {
    version: '1.30.2',
    date: '2026-06-07',
    highlights: [
      { category: 'fix', text: 'Fill Settings + app-wide translation gaps' },
    ],
  },
  {
    version: '1.30.1',
    date: '2026-06-06',
    highlights: [
      { category: 'improvement', text: 'Heatmap: color trailing days from adjacent months' },
    ],
  },
  {
    version: '1.30.0',
    date: '2026-06-05',
    highlights: [
      { category: 'feature', text: 'Cost per ACV: account view (# opps + avg cost/opp)' },
    ],
  },
  {
    version: '1.29.1',
    date: '2026-06-04',
    highlights: [
      { category: 'improvement', text: 'Cost per ACV: chip dropdown + toggle icons + dynamic column' },
    ],
  },
]
