# Third-party notices

ImpactIQ is licensed under the Apache License 2.0 (see `LICENSE` and `NOTICE`). This file lists material in this
repository that comes from elsewhere or is covered by other terms.

## npm packages

Every runtime and development dependency is listed, with its version, in `package-lock.json`. Each package carries its
own license file under `node_modules/<package>` after `npm install`. To print a summary:

```bash
npx license-checker --production --summary
```

## Brand marks (trademarks)

`src/client/components/admin/ai/AiProviderLogo.tsx` draws the Anthropic, OpenAI, Google Gemini, xAI and AWS marks
from [Simple Icons](https://simpleicons.org/) (version 13.21.0). The SVG paths are released under CC0-1.0.
The marks themselves are trademarks of their owners. They appear only to identify which AI provider an admin has
configured, which does not imply endorsement. Their use is subject to each owner's brand guidelines.

Salesforce, HubSpot, Microsoft, Outlook, Okta, Slack, Gong and the other product names in this repository are
trademarks of their owners, named only to describe what ImpactIQ connects to.

## Icons

UI icons come from [Lucide](https://lucide.dev/) (`lucide-react`, ISC license).

## Images

| File | Origin |
|---|---|
| `src/client/public/logo-9-iq-spark-arcs.svg`, `src/client/public/favicon.svg`, `public/impactiq-mark.svg`, `public/impactiq-mark.png` | ImpactIQ's own mark, Apache-2.0 with the rest of the project |
| `src/client/public/world.webp` | World-map background used on the sign-in page and page headers, from a free-to-use image source |
