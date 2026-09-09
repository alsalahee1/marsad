import { z } from 'zod';

/**
 * The six run states from CLAUDE.md §3. They map 1:1 to the `--state-*` colour tokens in
 * marsad-theme.css. Adding a seventh state means adding a token first.
 */
export const RUN_STATUSES = ['queued', 'running', 'blocked', 'done', 'failed', 'halted'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Terminal states: a run never leaves one of these. */
export const TERMINAL_RUN_STATUSES = [
  'done',
  'failed',
  'halted',
] as const satisfies readonly RunStatus[];

/**
 * Blast radius of a tool (CLAUDE.md §2.2). Communicated in the UI by a border stripe
 * (`.action--costly`, `.action--irreversible`), never by a colour.
 */
export const BLAST_RADII = ['reversible', 'costly', 'irreversible'] as const;
export const BlastRadiusSchema = z.enum(BLAST_RADII);
export type BlastRadius = z.infer<typeof BlastRadiusSchema>;

export const TOOL_CALL_STATUSES = [
  'pending',
  'awaiting_approval',
  'approved',
  'rejected',
  'blocked',
  'executing',
  'executed',
  'failed',
] as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUSES);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalDecisionSchema = z.enum(['approve', 'reject']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const BUDGET_SCOPES = ['run', 'day'] as const;
export const BudgetScopeSchema = z.enum(BUDGET_SCOPES);
export type BudgetScope = z.infer<typeof BudgetScopeSchema>;

/** Why a run stopped. `ceiling.*` are the hard per-run ceilings; `system.halt` is the global switch. */
export const HALT_REASONS = [
  'ceiling.steps',
  'ceiling.tokens',
  'ceiling.wall_clock',
  'system.halt',
  'operator',
] as const;
export const HaltReasonSchema = z.enum(HALT_REASONS);
export type HaltReason = z.infer<typeof HaltReasonSchema>;

export const BLOCK_REASONS = ['approval', 'budget'] as const;
export const BlockReasonSchema = z.enum(BLOCK_REASONS);
export type BlockReason = z.infer<typeof BlockReasonSchema>;
