# Git Worktrees (SMDApp)

## Core Principle

Isolate feature work from main branch. Never commit experimental code directly to main.

**Current problem**: All work goes directly to `main`. No branch isolation. No code review before merge.

## When to Use

- Any feature touching 3+ files
- Experimental engines or APIs
- Refactoring existing modules
- anything that might break existing features

**Skip for**: 1-2 line bug fixes, config changes, documentation

## Quick Start

### Create Worktree

```bash
# From project root
git worktree add ../SMDApp-<feature-name> -b <feature-name>

# Example:
git worktree add ../SMDApp-cas-time-engine -b feature/cas-time-engine
```

### Work in Isolation

```bash
cd ../SMDApp-<feature-name>
bun install
bun run dev        # verify it works
bun test           # verify tests pass
```

### Merge When Ready

```bash
cd /home/sachin/Desktop/SMDApp
git merge <feature-name>
git worktree remove ../SMDApp-<feature-name>
```

### Clean Up

```bash
git branch -d <feature-name>
```

## Directory Convention

Worktrees go in `../SMDApp-<name>` (sibling to main project, not inside it).

**Never create worktrees inside the project directory.** This avoids accidentally committing worktree contents.

## Branch Naming

| Prefix | Purpose |
|---|---|
| `feature/` | New functionality |
| `fix/` | Bug fixes |
| `refactor/` | Code restructuring |
| `experiment/` | Prototyping (delete when done) |

## Workflow with Architecture Guardian

1. Complete Architecture Guardian Phases 1-5 (audit, dependency graph, duplicate detection, integration plan, approval)
2. **Then** create worktree for the approved plan
3. Implement in worktree
4. Run `bun test` + `bun run build` in worktree
5. Merge to main
6. Remove worktree

## Common Scenarios

### Scenario: Building a new engine (e.g., CAS Time Engine)

```bash
git worktree add ../SMDApp-cas-time-engine -b feature/cas-time-engine
cd ../SMDApp-cas-time-engine
# ... implement, test ...
cd /home/sachin/Desktop/SMDApp
git merge feature/cas-time-engine
git worktree remove ../SMDApp-cas-time-engine
```

### Scenario: Experiment that might not work

```bash
git worktree add ../SMDApp-experiment-new-algo -b experiment/new-algo
cd ../SMDApp-experiment-new-algo
# ... try things ...
# If it works: merge
# If it doesn't: just remove
git worktree remove --force ../SMDApp-experiment-new-algo
```

### Scenario: Quick fix (no worktree needed)

```bash
# Just fix on main directly
# But commit immediately after
```

## Safety Rules

1. **Always run `bun test` before merging** — dirty merges break main
2. **Never force-push a worktree branch** — it might be shared
3. **Remove worktrees after merge** — don't leave orphaned directories
4. **Check `.gitignore`** — worktree directories should not be inside the project
