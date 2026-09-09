# MARSAD — Agent Operations Desk

Single-operator control room for autonomous agents doing real work on real
systems. Self-hosted. One expert user (the owner). No marketing surface, no
onboarding, no empty-state illustrations.

The screen answers four questions instantly:
who is running, how much has been spent, what is waiting for my decision,
what broke.

---

## 1. Stack — locked, do not substitute

| Layer | Choice |
|---|---|
| Runtime | Node 22, TypeScript strict |
| API | Express |
| Queue | BullMQ + Redis |
| Store | MySQL |
| Live feed | SSE (one-way, auto-reconnect). **Not** WebSocket |
| Frontend | React + Vite + TypeScript + Tailwind v4 |
| Deploy | Docker container behind Nginx on the existing VPS |

No agent framework. The tool-calling loop is written by hand with a closed,
typed tool registry.

## 2. Security invariants — non-negotiable

These are correctness requirements, not preferences. A PR that weakens any
of them is rejected.

1. **Prompts are not a security boundary.** Every limit is enforced in the
   executor before the tool runs. Never in system-prompt text.
2. **Every tool declares a blast radius**: `reversible` | `costly` |
   `irreversible`. A tool without one fails registration at boot.
   - `reversible` — auto-executes.
   - `costly` — auto-executes under a server-side per-run and per-day cap
     (amount + call count). Cap exceeded = run pauses, not silently skips.
   - `irreversible` — **always** enters the approval queue. No config value,
     no env var, no flag can bypass this path.
3. **Global halt.** One switch stops every worker and drains the queue.
   Reachable in one tap from any screen.
4. **Append-only event log.** Every agent step is a row. No UPDATE, no
   DELETE on the events table. The dashboard is a projection of this log —
   never a separate in-memory state.
5. **Idempotency keys** on every side-effecting tool call, so a retrying
   worker cannot double-execute.
6. **Hard ceilings per run**: max steps, max tokens, max wall-clock. Exceeded
   = run terminates as `halted`, logged with reason.
7. **Secrets are server-side only.** Nothing in the client bundle. Agents get
   tools, never raw DB or API credentials.
8. Approval tokens are single-use, expiring, and bound to one tool call.

## 3. Data model (minimum)

`agents` · `runs` · `events` (append-only) · `tool_calls` · `approvals` ·
`budgets` · `tools` (registry snapshot with blast radius).

`runs.status`: `queued` `running` `blocked` `done` `failed` `halted`.
These six map 1:1 to the state colours in the theme. Do not add a seventh
without adding its token.

## 4. Design system

Import `marsad-theme.css` after `@import "tailwindcss";`. All colour,
spacing, radius, elevation and motion come from it. Never hardcode a hex.

Rules that are easy to break and must not be:

- **All numbers are tabular monospace.** A live value must never shift the
  layout when it updates.
- **Colour is fully spent on run state.** Blast radius is communicated by a
  border stripe (`.action--costly`, `.action--irreversible`), never by an
  additional hue.
- **Shadow means elevation only.** A panel resting on the desk has none.
- **Uppercase only on state chips.** Panel titles and labels are sentence
  case.
- Only one non-user-triggered animation exists: the 600ms flash on a changed
  value. Do not add ambient motion.

## 5. Responsive standard

Breakpoints: Phone 0–599 · Fold 600–767 · Tablet 768–1023 · Desktop
1024–1439 · Wide 1440+.

- **Desktop** — icon rail (56px, expands to 240) + panel grid, 12px gaps.
- **Wide** — same, plus a 380px inspector pane on the trailing side.
- **Tablet** — rail stays icon-only; list-detail two-pane (agent list +
  detail).
- **Fold** — single column, top nav, list and detail stacked.
- **Phone** — the grid is deleted, not shrunk. Bottom tab bar with exactly
  five destinations: Desk, Agents, Approvals, Log, Settings. Agent cards
  replace tables. Full-screen sheets replace dialogs. 44px minimum touch
  targets. Safe-area insets respected. Swipe on an approval row to approve
  or reject.
- **Phone sticky action is "Halt all"**, in the bottom thumb zone. On a tool
  that executes autonomously, the thing you need from a phone is stopping it,
  not starting something.

The six-series chart does not go to phone. It is replaced by a single metric
and value. Do not scale it down.

## 6. Components

**Web** — panel shell, agent roster table (virtualised), event log stream
(virtualised, follow-tail toggle), budget meter, approval queue row with risk
stripe, run timeline, command palette (⌘K), inspector pane, density toggle.

**Phone-native** — bottom tab bar, agent card list, bottom sheet for run
detail, swipeable approval row, sticky halt bar, pull-to-refresh on the log.

Build the shell and the event log first. Everything else renders from the
same event stream, so the log is the foundation, not a side panel.

## 7. Definition of done

A task is done when it renders correctly at 375, 600, 768, 1024 and 1440px,
keyboard focus is visible, `prefers-reduced-motion` is respected, no hex is
hardcoded, and no limit was implemented in prompt text.
