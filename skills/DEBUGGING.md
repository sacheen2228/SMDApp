# Systematic Debugging (SMDApp)

## Core Principle

**ALWAYS find root cause before attempting fixes.** Symptom fixes are failure.

## The Iron Law

```
NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST
```

If you haven't completed Phase 1, you cannot propose fixes.

## Four Phases

### Phase 1: Root Cause Investigation

**BEFORE attempting ANY fix:**

1. **Read the error message completely** — don't skip stack traces. Note file, line, error code.
2. **Reproduce consistently** — exact steps. If not reproducible, gather more data.
3. **Check recent changes** — `git log --oneline -10`, `git diff`, new dependencies.
4. **Add diagnostic logging** — for multi-component systems (API → engine → DB):

```bash
# For API route issues:
console.log("[DEBUG] Input:", JSON.stringify(input).slice(0, 200));
console.log("[DEBUG] Source:", dataSource);
console.log("[DEBUG] Result:", JSON.stringify(result).slice(0, 200));

# For data pipeline issues:
console.log("[DEBUG] Breeze auth:", session ? "OK" : "FAILED");
console.log("[DEBUG] NSE fallback:", nseData ? "OK" : "FAILED");
console.log("[DEBUG] Yahoo fallback:", yahooData ? "OK" : "FAILED");
```

5. **Trace the data flow** — follow the value backward through the call stack.

### Phase 2: Pattern Analysis

1. **Find working examples** — similar code that works in the same codebase
2. **Compare** — what's different between working and broken?
3. **Check data sources** — is the issue real data or fake/mock data?

### Phase 3: Hypothesis and Testing

1. **Form ONE hypothesis** — "I think X is the root cause because Y"
2. **Test minimally** — smallest possible change
3. **Verify** — did it work? If not, new hypothesis. Don't stack fixes.

**After 3 failed fixes: STOP. Question the architecture.**

### Phase 4: Implementation

1. **Create failing test** — reproduce the bug
2. **Implement single fix** — address root cause only
3. **Verify fix** — test passes, no regressions
4. **Commit** — clear message referencing the bug

## SMDApp-Specific Debugging Patterns

### API Returns Empty/Null Data

```
Check in order:
1. Is Breeze session valid? → check /tmp/smdapp.log for "initSession error"
2. Did NSE fallback fire? → check log for "[API] NSE API data fetched"
3. Did Yahoo fallback fire? → check log for "[Yahoo] Fetching"
4. Is the endpoint responding? → curl -s http://localhost:3000/api/<endpoint>
5. Is the data shape correct? → check API response JSON
```

### Backtest Returns Wrong Results

```
Check in order:
1. Are candles real or fake? → check log for "Breeze Historical" vs "Yahoo"
2. Is the entry timestamp correct? → check entryTime vs market hours
3. Are exit conditions firing? → add console.log to exit checks
4. Is P&L calculation right? → verify with known trade manually
```

### Build Fails After Changes

```
Check in order:
1. TypeScript errors → bun run build 2>&1 | grep "error"
2. Missing imports → check import paths
3. Circular dependencies → check import chain
4. Prisma schema mismatch → bun run db:push
```

### Dev Server Won't Start

```
Check in order:
1. Port in use → lsof -i :3000
2. .next cache corruption → rm -rf .next && bun run dev
3. Memory limit → NODE_OPTIONS=--max-old-space-size=350
4. Log file → tail -50 /tmp/smdapp.log
```

### Breeze Auth Failures

```
Expected behavior — falls back to NSE/Yahoo.
Check:
1. Are API keys valid? → .env BREEZE_API_KEY, BREEZE_SECRET_KEY
2. Is session expired? → log shows "Could not authenticate credentials"
3. Is TOTP working? → check time sync
```

## Red Flags — STOP and Follow Process

- "Quick fix for now, investigate later"
- "Just try changing X and see if it works"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- Proposing solutions before reading error messages
- **3+ fixes attempted without resolution**

**ALL of these mean: STOP. Return to Phase 1.**

## When Stuck

| Problem | Solution |
|---|---|
| Don't understand the error | Read the full stack trace. Google the error message. |
| Can't reproduce | Add logging. Run in watch mode. Check timing. |
| Fix breaks other things | You're fixing symptoms, not root cause. Re-investigate. |
| Multiple components involved | Add logging at each boundary. Find the failing layer. |
| External API issue | Check if the API is down. Check rate limits. Check auth. |
