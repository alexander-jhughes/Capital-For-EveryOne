# Product workstream: command centre, Learning Lab, goals, onboarding

Branch `feat/product-ux`, from `claude/serene-rubin-2badwa` (`c5b7a0c`). Contract changes for other workstreams are in
`docs/INTEGRATION.md`, "Product workstream".

## What's here

| Area | Where | Notes |
|---|---|---|
| Onboarding at `/` | `components/onboarding/onboarding.tsx` | 4 steps, each skippable: view (with live previews), reading comfort, Home sections, charts, Learning Lab, ML suggestions (Alex's consent switch, off by default). Saved only on finish. |
| Command centre on Home | `components/home/command-centre.tsx`, `home-screen.tsx` | Spending by category (with change vs the same days last month, pending and refunds stated), coming up, payments and history, your progress. Credit utilisation as a figure, and "What do these figures mean?" for each balance figure. |
| Credit Learning Lab | `/account/learn`, `components/learn/*`, `lib/learn/*` | Utilisation simulator, minimum payment explainer, APR and interest calculator, statement explainer, 8-question quiz. Deterministic and tested; every calculator is labelled illustrative. Quiz answers are kept on the device only. |
| Goals | `components/goals/goals-screen.tsx`, `lib/goals/*` | New: reduce what I owe, use less of my limit, pay on time, emergency fund, save for something. Editing, milestones (25/50/75/100), history, a weekly check-in, and a celebration (announced) when a milestone is reached. Supportive wording; a missed goal is "not this time". |
| Navigation | `components/more-menu.tsx`, `components/app-nav.tsx` | Phones had no route to Goals or Display settings. Now there's a "More" button in the header. The desktop rail lists the same pages. |
| Preferences | `lib/preferences/schema.ts`, Display and voice | Charts or lists; Learning Lab on or off. |
| Shared UI | `components/ui/panel.tsx` | Panel, Meter (role=meter with a text value), BarList (text figures, bars hidden from screen readers), EmptyState, Skeleton. |
| Demo | `app/demo/reset/route.ts`, "Demo data" labels | `/?demo=reset` starts everything again. |

Not built, on purpose: reminders outside the app (no push notifications in scope), a credit score (never invented),
a breakdown by account (the data has one card), a utilisation trend over time (there's no balance history to draw it
from honestly).

## Run and test

```bash
npm ci
npm run build
SESSION_SECRET=$(openssl rand -base64 32) npx next start -p 3100   # without it, changes aren't kept in production
npm test && npm run typecheck && npm run lint
BASE_URL=http://localhost:3100 npm run test:product                # 72 browser checks, screenshots in docs/screenshots/product
```

## Demo script for judges (about 2 minutes, works with no Gemini key)

1. Open `/?demo=reset`. The welcome screen says it's demo data. Choose **Set up my view**.
2. Pick **Simple**: the page changes as you choose. Continue, choose **150%** text, continue, tick **Your progress**,
   continue, **Sign in to the demo**.
3. Home: "Your bill is £486.20, due Friday 13 November". Open **Total balance → What do these figures mean?**.
4. Switch to **Detailed** at the top: categories, coming up, payments, progress, with 71% of the limit used.
5. **More → Learning Lab → Credit utilisation**: tap **£250** and utilisation drops to 55%. Then **Minimum payments**:
   £25 more a month clears the bill sooner for less interest.
6. **More → Goals → Add a goal → Build an emergency fund**, £1,000. Update what you've saved to £500: "Milestone
   reached: 50%".
7. Ask Dial "Did I pay Tesco twice this month?" (Alex's flow): the answer and evidence work alongside everything above.
