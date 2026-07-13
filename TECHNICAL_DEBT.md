# TECHNICAL DEBT

Logged during the M6-precursor Validation Phase. These are **pre-existing** errors
in `src/components/terminal/ZeroHeroTerminal.tsx` — they predate the Market
Recorder / Replay Engine / Scanner Recording work (M2–M5) and are **outside**
the code added in those modules. Per `next.config.ts` (`ignoreBuildErrors: true`)
the production build does NOT fail on them, so they are **non-blocking for the
current phase**. They **must be fixed before any production deployment**.

---

## TD-1 — Invalid `Color` prop type
- **Location:** `src/components/terminal/ZeroHeroTerminal.tsx:703:31`
- **Error:** `TS2322: Type 'string | number' is not assignable to type 'Color | undefined'.`
- **Root cause:** A color/text-color prop (likely regime → color mapping, or a
  Badge/icon color) receives a value typed `string | number`. The `number`
  branch (e.g. an HSL component or opacity number) is not a valid `Color`,
  so the prop will be `undefined`/wrong at runtime when numeric.
- **Impact:** Cosmetic-to-moderate. Affected element may render with no/incorrect
  color; risk of a runtime surprise if a numeric color reaches a string-only prop.
- **Fix:** Coerce the source to a CSS color string (template literal / `String(...)`)
  and back it with a typed `Record<Regime, string>` color map so the type is
  always `string`. Add a unit assertion that the map values are strings.
- **Severity:** Medium. **Must fix before production.**

## TD-2 — Unintentional comparison (always false)
- **Location:** `src/components/terminal/ZeroHeroTerminal.tsx:1000:25`
- **Error:** `TS2367: This comparison appears to be unintentional because the
  types '"IV" | "Delta" | "Theta" | "Gamma" | "Vega"' and '"CE"' have no overlap.`
- **Root cause:** A condition compares a Greek-metric key (`IV | Delta | Theta |
  Gamma | Vega`) against `"CE"`. The variable holds a Greek name, not an
  option type, so the comparison is **always false** — a dead branch / logic bug.
- **Impact:** A filter/highlight that was meant to apply to CE options never
  triggers. Silent incorrect behaviour (not a crash).
- **Fix:** Compare the correct variable (the option `type` — `"CE" | "PE"`) instead
  of the Greek-metric key; or restructure so the Greek key and option type are
  not conflated.
- **Severity:** Medium (logic correctness). **Must fix before production.**

---

_Logged: Validation Phase (pre-M6). Re-validate with `npx tsc --noEmit` after fixes._
