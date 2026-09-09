import type { BlastRadius, Event, HaltReason, RunStatus } from '@marsad/shared';
import { formatInt, formatMs, formatUsd, shortId } from '../lib/format.js';

/**
 * A one-line summary is a list of segments so that every number renders in a `.num` cell
 * (tabular monospace) while the words stay in the UI face. The theme's rule is that numbers
 * never sit in proportional type, and this is where it is enforced for the log.
 */
export type Segment = { kind: 'text'; text: string } | { kind: 'num'; text: string };

const t = (text: string): Segment => ({ kind: 'text', text });
const n = (text: string): Segment => ({ kind: 'num', text });

function truncate(s: string, max: number): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function json(value: unknown, max = 80): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = '[unserialisable]';
  }
  return truncate(s, max);
}

export function summarize(event: Event): Segment[] {
  switch (event.type) {
    case 'run.created':
      return [
        t('Run created for agent '),
        n(shortId(event.payload.agentId)),
        t(' · '),
        t(truncate(event.payload.task, 120)),
      ];
    case 'run.started':
      return [t(event.payload.resumed ? 'Run resumed by worker' : 'Run started')];
    case 'run.step':
      return [
        t('Step '),
        n(String(event.payload.step)),
        t(' · '),
        t(
          event.payload.decision === 'tool_call'
            ? `calls ${event.payload.tool ?? 'tool'}`
            : event.payload.decision,
        ),
        t(' · '),
        n(formatInt(event.payload.tokensUsed)),
        t(' tokens'),
      ];
    case 'run.blocked':
      return event.payload.reason === 'approval'
        ? [t('Blocked: waiting for your approval')]
        : [
            t('Blocked: budget cap reached'),
            ...(event.payload.budget
              ? [
                  t(' · '),
                  n(formatUsd(event.payload.budget.spentUsd)),
                  t(' of '),
                  n(formatUsd(event.payload.budget.capUsd)),
                  t(` per ${event.payload.budget.scope}`),
                ]
              : []),
          ];
    case 'run.resumed':
      return [
        t(event.payload.via === 'approval' ? 'Resumed after approval' : 'Resumed by operator'),
      ];
    case 'run.done':
      return [
        t('Done after '),
        n(String(event.payload.steps)),
        t(' steps · '),
        t(json(event.payload.output)),
      ];
    case 'run.failed':
      return [
        t('Failed after '),
        n(String(event.payload.steps)),
        t(' steps · '),
        t(truncate(event.payload.error, 120)),
      ];
    case 'run.halted': {
      const p = event.payload;
      const head = t(haltReasonText(p.reason));
      if (p.limit !== undefined && p.value !== undefined)
        return [head, t(' · '), n(String(p.value)), t(' of '), n(String(p.limit))];
      return p.detail ? [head, t(' · '), t(truncate(p.detail, 100))] : [head];
    }
    case 'tool.requested':
      return [
        t(`${event.payload.tool} requested`),
        t(` (${event.payload.blastRadius})`),
        ...(event.payload.blastRadius === 'costly'
          ? [t(' · est. '), n(formatUsd(event.payload.estimatedCostUsd))]
          : []),
        t(' · '),
        t(json(event.payload.input, 60)),
      ];
    case 'tool.completed':
      return [
        t(`${event.payload.tool} completed in `),
        n(formatMs(event.payload.durationMs)),
        ...(event.payload.actualCostUsd > 0
          ? [t(' · cost '), n(formatUsd(event.payload.actualCostUsd))]
          : []),
      ];
    case 'tool.failed':
      return [
        t(`${event.payload.tool} failed at step `),
        n(String(event.payload.step)),
        t(' · '),
        t(truncate(event.payload.error, 100)),
      ];
    case 'approval.requested':
      return [
        t(`Approval needed: ${event.payload.tool} at step `),
        n(String(event.payload.step)),
        t(' · '),
        t(json(event.payload.input, 60)),
      ];
    case 'approval.token_issued':
      return [t('Approval token issued for '), n(shortId(event.payload.approvalId))];
    case 'approval.decided':
      return [
        t(
          `${event.payload.decision === 'approve' ? 'Approved' : 'Rejected'} by ${event.payload.decidedBy}`,
        ),
      ];
    case 'budget.exceeded':
      return [
        t(`Budget exceeded (${event.payload.scope}): attempted `),
        n(formatUsd(event.payload.attemptedUsd)),
        t(' with '),
        n(formatUsd(event.payload.spentUsd)),
        t(' of '),
        n(formatUsd(event.payload.capUsd)),
        t(' spent'),
      ];
    case 'system.halted':
      return [
        t(`Global halt by ${event.payload.by}: ${event.payload.reason} · `),
        n(String(event.payload.drainedJobs)),
        t(' jobs drained, '),
        n(String(event.payload.haltedRuns.length)),
        t(' runs halted'),
      ];
    case 'system.resumed':
      return [t(`Global halt released by ${event.payload.by}`)];
    case 'tools.snapshotted':
      return [t('Tool registry snapshotted: '), n(String(event.payload.tools.length)), t(' tools')];
    case 'agent.created':
      return [t(`Agent ${event.payload.name} created`)];
    case 'auth.login':
      return [
        t(
          event.payload.ok
            ? `Operator signed in from ${event.payload.ip}`
            : `Failed login from ${event.payload.ip}`,
        ),
      ];
  }
}

function haltReasonText(reason: HaltReason): string {
  switch (reason) {
    case 'ceiling.steps':
      return 'Halted: step ceiling';
    case 'ceiling.tokens':
      return 'Halted: token ceiling';
    case 'ceiling.wall_clock':
      return 'Halted: wall-clock ceiling';
    case 'system.halt':
      return 'Halted by the global halt';
    case 'operator':
      return 'Halted by operator';
  }
}

/** The run state this event moves its run into, if any: the only thing colour is spent on. */
export function impliedRunState(event: Event): RunStatus | null {
  switch (event.type) {
    case 'run.created':
      return 'queued';
    case 'run.started':
    case 'run.resumed':
    case 'system.resumed':
      return 'running';
    case 'run.blocked':
    case 'approval.requested':
    case 'budget.exceeded':
      return 'blocked';
    case 'run.done':
      return 'done';
    case 'run.failed':
      return 'failed';
    case 'run.halted':
    case 'system.halted':
      return 'halted';
    default:
      return null;
  }
}

/** Blast radius of the action an event describes, for the structural risk stripe. */
export function blastRadiusOf(event: Event): BlastRadius | null {
  switch (event.type) {
    case 'tool.requested':
      return event.payload.blastRadius;
    case 'approval.requested':
    case 'approval.token_issued':
    case 'approval.decided':
      // Only irreversible tools ever enter the approval queue.
      return 'irreversible';
    default:
      return null;
  }
}

export function segmentsToText(segments: readonly Segment[]): string {
  return segments.map((s) => s.text).join('');
}
