# Design — ProcureBrain

A shared design system for the purchasing workspace. Use this system across screens; extend the tokens rather than introducing local colors or new font families.

## Audience, use case, and tone

- Audience: a small business owner handling purchasing.
- Main job: catch supplier changes, inspect the source, and approve an order update.
- Tone: **soft utilitarian — calm, readable, warm**, chosen by the owner.
- The prototype remains under development. Display real API data and clear empty states; never fabricate trends, accuracy, connected channels, or customer metrics.

## Genre and structure

Modern minimal. **Workbench**, adapted for the live app rather than a marketing tour: a quiet side rail, functional page headings, one summary strip, and task-oriented workspaces.

- Overview: totals above an attention queue and order register; capture and upcoming deliveries in a secondary column.
- Orders: attention summary and searchable register, with history in a native dialog.
- Messages: saved-message list and source detail, with order matching and proposal preparation.
- Reviews: proposal list and comparison, with approval/edit/reject controls.
- Imports: CSV/document mode choices and a working form with supporting instructions.
- Suppliers: directory and contact/linked-order dialogs.
- Evidence: searchable original-source records.
- History: recorded analysis outcomes and inspection dialog.
- Guide: implementation status, dataset roles, and concept explanations.

Navigation: N3 side rail with six everyday destinations: Home, Orders, Messages, Check changes, Email alerts, and Suppliers. A More options disclosure keeps file uploads, examples, saved originals, technical history, and project information accessible. Footer: Ft2 compact connection/storage status. On phones the rail becomes a keyboard-accessible drawer. Order, supplier, and history tables become stacked records.

## Familiar language and a short task flow

Use the language guide in `docs/PLAIN_LANGUAGE_UX.md`. Apply principles inspired by ASD-STE100: simple words, consistent meanings, and direct instructions. This is not a verified STE compliance claim.

- Main task: **Add message → Check change → Update order**.
- Say **order**, **delivery date**, **supplier message**, and **suggested change** in everyday screens.
- Primary buttons name the outcome: **Check message**, **Update delivery date**, **Update quantity**.
- Start the message form with pasted text and an optional order choice. Put extra details behind a disclosure. Keep required sender fields visible for email and phone messages.
- Show the original supplier message beside the suggested change. Keep AI estimates and system data behind details.
- Show actual message outcomes. A finished extraction does not necessarily mean a change is ready.
- Explain email preview and sending status separately. Never call an accepted email delivered.
- Begin learning with three examples; offer all 34 as an explicit choice.
- Spreadsheet uploads require a file check before adding records. Explain that adding spreadsheet records updates orders immediately.

## Theme

Coral's warm minimalism adapted to the existing ProcureBrain sage and terracotta brand. Warm paper, light navigation, dark green primary actions, and restrained terracotta attention cues. Status colors are semantic, paired with text or icons.

`tokens.css` is the source of truth; imported by `apps/web/src/hallmark.css`. Existing stylesheet and component ownership are retained. The refinement layer loads after the entry stylesheet.

## Typography

- Display: locally hosted Geist, roman, weight 550–650; tight tracking (-0.025 to -0.035em).
- Body and controls: locally hosted Manrope, weight 400–750.
- Code only: SFMono-Regular / Cascadia Mono / monospace fallback.
- Body: 14 px; labels 12–13 px; screen headings 28–36 px.
- Numbers use tabular figures where alignment matters. No animated counters or italic headings.

Both bundled font families include their SIL Open Font License in `apps/web/public/fonts`.

## Spacing and components

Named 4-point spacing scale in `tokens.css`: 4, 8, 12, 16, 24, 32, 48, 64, and 96 px. Card radius 12 px, controls 8 px. One surface per work area; use rows, whitespace, and rules inside it.

- Primary: green fill, light text, verb-led label.
- Secondary: light fill, visible neutral border.
- Destructive: warm red with an explicit action label.
- Controls: 44 px touch target; no wrapped action labels.
- Fields: visible labels, constant border width, immediate focus outline, stable helper space.
- Status: include words; color is supplementary.
- Original evidence and technical details are secondary to the review task.

## Motion and accessibility

No page or scroll reveals. Control press feedback and the mobile drawer are the only spatial interactions. Functional loading indicators retain their role. Named easings; reduced motion removes transforms/animation.

Native dialogs provide focus containment and Escape dismissal. Opening a form focuses its first usable field. The mobile drawer makes the main surface inert, contains keyboard focus, closes on Escape, and restores focus.

## Shared rules

All screens share typography, palette, control geometry, divider treatment, focus feedback, and truthful status copy. App pages have no decorative imagery or fake browser/phone frames. Short section headings replace decorative eyebrows. Desktop rows and mobile records retain the same data and actions.

## Review scope

Browser checks covered all nine screens at 320, 375, 414, and 768 px, plus desktop layouts. The contrast inspection covered rendered text in populated views and empty states. Capture/order dialogs and mobile navigation were inspected. Live AI extraction, OCR, and proposal approval were not executed during the design pass. A populated review comparison still needs an end-to-end walkthrough with a real proposal.

## Exports

The following are portable copies, not additional runtime dependencies. ProcureBrain loads only `tokens.css`.

### CSS tokens

```css
/* ProcureBrain · Hallmark design tokens · warm, soft utilitarian */
:root {
  --color-paper: oklch(97.7% 0.006 85);
  --color-surface: oklch(99.6% 0.002 85);
  --color-paper-2: oklch(95.3% 0.009 85);
  --color-paper-3: oklch(92.2% 0.015 145);
  --color-ink: oklch(27% 0.022 158);
  --color-ink-2: oklch(39% 0.019 158);
  --color-muted: oklch(48% 0.015 158);
  --color-neutral: oklch(42% 0.017 158);
  --color-rule: oklch(88% 0.009 85);
  --color-rule-soft: oklch(93% 0.006 85);
  --color-rule-2: oklch(72% 0.014 145);
  --color-accent: oklch(49% 0.12 45);
  --color-accent-ink: oklch(99.6% 0.002 85);
  --color-accent-soft: oklch(95% 0.025 65);
  --color-primary: oklch(36% 0.041 158);
  --color-primary-hover: oklch(29% 0.035 158);
  --color-primary-ink: oklch(99% 0.006 145);
  --color-sage: oklch(94% 0.017 145);
  --color-success: oklch(40% 0.06 155);
  --color-success-soft: oklch(95% 0.025 145);
  --color-warning: oklch(43% 0.08 65);
  --color-warning-soft: oklch(96% 0.03 80);
  --color-error: oklch(45% 0.12 30);
  --color-error-soft: oklch(96% 0.025 35);
  --color-info: oklch(43% 0.045 235);
  --color-info-soft: oklch(95% 0.012 235);
  --color-focus: oklch(63% 0.18 255);
  --color-overlay: oklch(25% 0.016 158 / 35%);
  --color-shadow: oklch(27% 0.02 158 / 8%);
  --color-transparent: oklch(100% 0 0 / 0%);
  --font-display: 'Geist', 'Manrope', sans-serif;
  --font-body: 'Manrope', 'Avenir Next', sans-serif;
  --font-outlier: 'SFMono-Regular', 'Cascadia Mono', monospace;
  --space-3xs: 0.25rem;
  --space-2xs: 0.5rem;
  --space-xs: 0.75rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2rem;
  --space-xl: 3rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-body: 0.875rem;
  --text-md: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5625rem;
  --text-2xl: 2rem;
  --text-display: clamp(1.75rem, 2.5vw, 2.25rem);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-micro: 120ms;
  --dur-short: 200ms;
  --dur-long: 300ms;
  --rule-hair: 1px;
  --rule-fine: 2px;
  --radius-card: 12px;
  --radius-input: 8px;
  --radius-pill: 999px;
  --shadow-modal: 0 24px 80px var(--color-shadow);
  --ink: var(--color-ink);
  --muted: var(--color-muted);
  --line: var(--color-rule);
  --orange: var(--color-accent);
  --sage: var(--color-success);
  --sidebar: var(--color-paper-2);
}
```

### Tailwind v4

```css
@theme {
  --color-paper: oklch(97.7% 0.006 85);
  --color-surface: oklch(99.6% 0.002 85);
  --color-paper-2: oklch(95.3% 0.009 85);
  --color-paper-3: oklch(92.2% 0.015 145);
  --color-ink: oklch(27% 0.022 158);
  --color-ink-2: oklch(39% 0.019 158);
  --color-muted: oklch(48% 0.015 158);
  --color-neutral: oklch(42% 0.017 158);
  --color-rule: oklch(88% 0.009 85);
  --color-rule-soft: oklch(93% 0.006 85);
  --color-rule-2: oklch(72% 0.014 145);
  --color-accent: oklch(49% 0.12 45);
  --color-accent-ink: oklch(99.6% 0.002 85);
  --color-accent-soft: oklch(95% 0.025 65);
  --color-primary: oklch(36% 0.041 158);
  --color-primary-hover: oklch(29% 0.035 158);
  --color-primary-ink: oklch(99% 0.006 145);
  --color-sage: oklch(94% 0.017 145);
  --color-success: oklch(40% 0.06 155);
  --color-success-soft: oklch(95% 0.025 145);
  --color-warning: oklch(43% 0.08 65);
  --color-warning-soft: oklch(96% 0.03 80);
  --color-error: oklch(45% 0.12 30);
  --color-error-soft: oklch(96% 0.025 35);
  --color-info: oklch(43% 0.045 235);
  --color-info-soft: oklch(95% 0.012 235);
  --color-focus: oklch(63% 0.18 255);
  --color-overlay: oklch(25% 0.016 158 / 35%);
  --color-shadow: oklch(27% 0.02 158 / 8%);
  --color-transparent: oklch(100% 0 0 / 0%);
  --font-display: 'Geist', 'Manrope', sans-serif;
  --font-body: 'Manrope', 'Avenir Next', sans-serif;
  --font-outlier: 'SFMono-Regular', 'Cascadia Mono', monospace;
  --spacing-3xs: 0.25rem;
  --spacing-2xs: 0.5rem;
  --spacing-xs: 0.75rem;
  --spacing-sm: 1rem;
  --spacing-md: 1.5rem;
  --spacing-lg: 2rem;
  --spacing-xl: 3rem;
  --spacing-2xl: 4rem;
  --spacing-3xl: 6rem;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-body: 0.875rem;
  --text-md: 1rem;
  --text-lg: 1.25rem;
  --text-xl: 1.5625rem;
  --text-2xl: 2rem;
  --text-display: clamp(1.75rem, 2.5vw, 2.25rem);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --radius-card: 12px;
  --radius-input: 8px;
  --radius-pill: 999px;
}
```

### DTCG token JSON

```json
{
  "color": {
    "paper": {
      "$value": "oklch(97.7% 0.006 85)",
      "$type": "color"
    },
    "surface": {
      "$value": "oklch(99.6% 0.002 85)",
      "$type": "color"
    },
    "paper-2": {
      "$value": "oklch(95.3% 0.009 85)",
      "$type": "color"
    },
    "paper-3": {
      "$value": "oklch(92.2% 0.015 145)",
      "$type": "color"
    },
    "ink": {
      "$value": "oklch(27% 0.022 158)",
      "$type": "color"
    },
    "ink-2": {
      "$value": "oklch(39% 0.019 158)",
      "$type": "color"
    },
    "muted": {
      "$value": "oklch(48% 0.015 158)",
      "$type": "color"
    },
    "neutral": {
      "$value": "oklch(42% 0.017 158)",
      "$type": "color"
    },
    "rule": {
      "$value": "oklch(88% 0.009 85)",
      "$type": "color"
    },
    "rule-soft": {
      "$value": "oklch(93% 0.006 85)",
      "$type": "color"
    },
    "rule-2": {
      "$value": "oklch(72% 0.014 145)",
      "$type": "color"
    },
    "accent": {
      "$value": "oklch(49% 0.12 45)",
      "$type": "color"
    },
    "accent-ink": {
      "$value": "oklch(99.6% 0.002 85)",
      "$type": "color"
    },
    "accent-soft": {
      "$value": "oklch(95% 0.025 65)",
      "$type": "color"
    },
    "primary": {
      "$value": "oklch(36% 0.041 158)",
      "$type": "color"
    },
    "primary-hover": {
      "$value": "oklch(29% 0.035 158)",
      "$type": "color"
    },
    "primary-ink": {
      "$value": "oklch(99% 0.006 145)",
      "$type": "color"
    },
    "sage": {
      "$value": "oklch(94% 0.017 145)",
      "$type": "color"
    },
    "success": {
      "$value": "oklch(40% 0.06 155)",
      "$type": "color"
    },
    "success-soft": {
      "$value": "oklch(95% 0.025 145)",
      "$type": "color"
    },
    "warning": {
      "$value": "oklch(43% 0.08 65)",
      "$type": "color"
    },
    "warning-soft": {
      "$value": "oklch(96% 0.03 80)",
      "$type": "color"
    },
    "error": {
      "$value": "oklch(45% 0.12 30)",
      "$type": "color"
    },
    "error-soft": {
      "$value": "oklch(96% 0.025 35)",
      "$type": "color"
    },
    "info": {
      "$value": "oklch(43% 0.045 235)",
      "$type": "color"
    },
    "info-soft": {
      "$value": "oklch(95% 0.012 235)",
      "$type": "color"
    },
    "focus": {
      "$value": "oklch(63% 0.18 255)",
      "$type": "color"
    },
    "overlay": {
      "$value": "oklch(25% 0.016 158 / 35%)",
      "$type": "color"
    },
    "shadow": {
      "$value": "oklch(27% 0.02 158 / 8%)",
      "$type": "color"
    },
    "transparent": {
      "$value": "oklch(100% 0 0 / 0%)",
      "$type": "color"
    }
  },
  "font": {
    "display": {
      "$value": "'Geist', 'Manrope', sans-serif",
      "$type": "fontFamily"
    },
    "body": {
      "$value": "'Manrope', 'Avenir Next', sans-serif",
      "$type": "fontFamily"
    },
    "outlier": {
      "$value": "'SFMono-Regular', 'Cascadia Mono', monospace",
      "$type": "fontFamily"
    }
  },
  "space": {
    "3xs": {
      "$value": "0.25rem",
      "$type": "dimension"
    },
    "2xs": {
      "$value": "0.5rem",
      "$type": "dimension"
    },
    "xs": {
      "$value": "0.75rem",
      "$type": "dimension"
    },
    "sm": {
      "$value": "1rem",
      "$type": "dimension"
    },
    "md": {
      "$value": "1.5rem",
      "$type": "dimension"
    },
    "lg": {
      "$value": "2rem",
      "$type": "dimension"
    },
    "xl": {
      "$value": "3rem",
      "$type": "dimension"
    },
    "2xl": {
      "$value": "4rem",
      "$type": "dimension"
    },
    "3xl": {
      "$value": "6rem",
      "$type": "dimension"
    }
  },
  "size": {
    "xs": {
      "$value": "0.75rem",
      "$type": "dimension"
    },
    "sm": {
      "$value": "0.8125rem",
      "$type": "dimension"
    },
    "body": {
      "$value": "0.875rem",
      "$type": "dimension"
    },
    "md": {
      "$value": "1rem",
      "$type": "dimension"
    },
    "lg": {
      "$value": "1.25rem",
      "$type": "dimension"
    },
    "xl": {
      "$value": "1.5625rem",
      "$type": "dimension"
    },
    "2xl": {
      "$value": "2rem",
      "$type": "dimension"
    },
    "display": {
      "$value": "2.25rem",
      "$type": "dimension"
    }
  },
  "duration": {
    "micro": {
      "$value": "120ms",
      "$type": "duration"
    },
    "short": {
      "$value": "200ms",
      "$type": "duration"
    },
    "long": {
      "$value": "300ms",
      "$type": "duration"
    }
  },
  "radius": {
    "card": {
      "$value": "12px",
      "$type": "dimension"
    },
    "input": {
      "$value": "8px",
      "$type": "dimension"
    },
    "pill": {
      "$value": "999px",
      "$type": "dimension"
    }
  }
}
```

### shadcn/ui variables

Uses complete OKLCH color values, suitable for current CSS-variable-based integrations. Map these semantic roles into a consuming application's theme.

```css
:root {
  --background: oklch(97.7% 0.006 85);
  --foreground: oklch(27% 0.022 158);
  --card: oklch(99.6% 0.002 85);
  --card-foreground: oklch(27% 0.022 158);
  --popover: oklch(99.6% 0.002 85);
  --popover-foreground: oklch(27% 0.022 158);
  --primary: oklch(36% 0.041 158);
  --primary-foreground: oklch(99% 0.006 145);
  --secondary: oklch(95.3% 0.009 85);
  --secondary-foreground: oklch(39% 0.019 158);
  --muted: oklch(95.3% 0.009 85);
  --muted-foreground: oklch(48% 0.015 158);
  --accent: oklch(94% 0.017 145);
  --accent-foreground: oklch(36% 0.041 158);
  --destructive: oklch(45% 0.12 30);
  --destructive-foreground: oklch(99.6% 0.002 85);
  --border: oklch(88% 0.009 85);
  --input: oklch(72% 0.014 145);
  --ring: oklch(63% 0.18 255);
  --radius: 0.5rem;
}
```
