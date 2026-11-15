// Pure logic for workflow runs (issue #233), node-free so it unit-tests without
// fs, git, or gh: the built-in workflows, the definition schema, the transition
// function, the phase prompts, the gates' parsing, and the run digest. The
// orchestration (sessions, commands, gh, the durable store) lives in
// workflow-runner.ts.
import { z } from 'zod';
import { EFFORT_LEVELS } from '$lib/effort';
import { AGENT_KINDS } from '$lib/types';
import type { SessionIssue } from '$lib/types';
import {
	type PushState,
	DONE,
	FINISHED_RUN,
	STEP_GATES,
	STEP_ROLES,
	WORKFLOW_CATEGORIES,
	type Coverage,
	type AcceptanceItem,
	type Finding,
	type FixReport,
	type Verification,
	type PhaseStatus,
	type PhaseVisit,
	type RunBlockKind,
	type RunDigest,
	type RunPhaseDigest,
	type RunPr,
	type StepAgent,
	type WorkflowCategory,
	type WorkflowDef,
	type WorkflowRun,
	type WorkflowStep
} from '$lib/workflows';

// ---- Built-in workflows ----

// The model tiers the dev-workflow skill already encodes: judgment work at the
// CLI's default (the session model), scoped verification and routine fixes at
// sonnet, and one shot at the top tier for a reviewer disagreement and for an
// exhausted round cap.
const SONNET: StepAgent = { kind: 'claude', model: 'sonnet' };
const SESSION: StepAgent = { kind: 'claude' };
const TOP: StepAgent = { kind: 'claude', model: 'claude-fable-5-1' };

const REVIEW_ROUND_CAP = 5;
const FEEDBACK_ROUND_CAP = 10;

// The dev loop with the prose stripped: a chain with two cycles in it (review
// and fix, then the reviewer's feedback after the PR is up).
const DEV_WORKFLOW: WorkflowDef = {
	id: 'dev',
	name: 'Dev workflow',
	category: 'dev',
	default: true,
	steps: [
		{ id: 'implement', label: 'Implement', role: 'implement', skill: 'dev-workflow', agent: SESSION, gate: 'turn', next: 'verify' },
		{ id: 'verify', label: 'Tests', role: 'verify', gate: 'exit-zero', next: 'review', onFail: 'fix', retries: 1 },
		{
			id: 'review',
			label: 'Review',
			role: 'review',
			skill: 'dev-review',
			agent: SESSION,
			repeatAgent: SONNET,
			gate: 'no-blockers',
			next: 'pr',
			onFail: 'fix',
			cap: REVIEW_ROUND_CAP
		},
		{ id: 'fix', label: 'Fix', role: 'fix', skill: 'dev-workflow', agent: SONNET, escalateAgent: SESSION, gate: 'turn', next: 'verify' },
		{ id: 'arbiter', label: 'Arbiter', role: 'arbiter', skill: 'dev-workflow', agent: TOP, gate: 'turn', next: 'verify', retries: 0 },
		{ id: 'closer', label: 'Closer', role: 'closer', skill: 'dev-workflow', agent: TOP, gate: 'turn', next: 'verify', retries: 0 },
		{ id: 'pr', label: 'Open PR', role: 'pr', skill: 'dev-workflow', agent: SONNET, gate: 'pr-linked', next: 'feedback', retries: 1 },
		{
			id: 'feedback',
			label: 'Reviewer feedback',
			role: 'feedback',
			skill: 'address-feedback',
			agent: SONNET,
			gate: 'pr-approved',
			next: DONE,
			cap: FEEDBACK_ROUND_CAP
		}
	]
};

const REVIEW_WORKFLOW: WorkflowDef = {
	id: 'review',
	name: 'PR review',
	category: 'review',
	default: true,
	steps: [
		{ id: 'review', label: 'Review', role: 'pr-review', skill: 'dev-review', agent: SESSION, gate: 'pr-reviewed', next: DONE }
	]
};

export const BUILTIN_WORKFLOWS: WorkflowDef[] = [DEV_WORKFLOW, REVIEW_WORKFLOW];

// ---- Definitions from ~/.deck/workflows.json ----

const agentSchema = z.object({
	kind: z.enum(AGENT_KINDS).optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	effort: z.enum(EFFORT_LEVELS).optional()
});

const stepSchema = z.object({
	id: z.string().min(1),
	label: z.string().min(1),
	role: z.enum(STEP_ROLES),
	skill: z.string().optional(),
	args: z.string().optional(),
	command: z.string().optional(),
	agent: agentSchema.optional(),
	repeatAgent: agentSchema.optional(),
	escalateAgent: agentSchema.optional(),
	gate: z.enum(STEP_GATES),
	next: z.string().min(1),
	onFail: z.string().optional(),
	retries: z.number().int().min(0).max(5).optional(),
	cap: z.number().int().min(1).max(20).optional()
});

const defSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	category: z.enum(WORKFLOW_CATEGORIES),
	default: z.boolean().optional(),
	variants: z.array(z.string().min(1)).min(1).optional(),
	steps: z.array(stepSchema).default([])
});

// The first transition that points nowhere, or null when every `next` and
// `onFail` names a step in the workflow (or DONE).
function danglingTransition(def: WorkflowDef): string | null {
	const ids = new Set(def.steps.map((s) => s.id));
	for (const s of def.steps) {
		for (const target of [s.next, s.onFail]) {
			if (target && target !== DONE && !ids.has(target)) return `${s.id} -> ${target}`;
		}
	}
	return null;
}

// A step id the engine can't reach: used twice, or `done`, which ends a run.
function idProblem(def: WorkflowDef): string | null {
	const ids = def.steps.map((s) => s.id);
	const dup = ids.find((id, i) => ids.indexOf(id) !== i);
	if (dup) return `step id used twice: ${dup}`;
	return ids.includes(DONE) ? `"${DONE}" is reserved and can't be a step id` : null;
}

// The gate each role must use where the role has a computed check, so a user
// definition can't swap one for a gate that passes on any reply. Roles absent
// here (implement, fix, arbiter, closer) are gated on their turn.
const ROLE_GATE: Partial<Record<WorkflowStep['role'], WorkflowStep['gate']>> = {
	verify: 'exit-zero',
	review: 'no-blockers',
	pr: 'pr-linked',
	feedback: 'pr-approved',
	'pr-review': 'pr-reviewed'
};

function gateFits(s: WorkflowStep): boolean {
	return s.gate === (ROLE_GATE[s.role] ?? 'turn');
}

// A step whose role can't work as declared: a session step with no skill, or a
// gate that doesn't match what the role is checked by.
function roleProblem(def: WorkflowDef): string | null {
	const bare = def.steps.find((s) => s.role !== 'verify' && !s.skill);
	if (bare) return `step ${bare.id} names no skill`;
	const loose = def.steps.find((s) => !gateFits(s));
	return loose ? `${loose.role} step ${loose.id} must use the ${ROLE_GATE[loose.role] ?? 'turn'} gate` : null;
}

// A shape problem the schema can't see.
function stepProblem(def: WorkflowDef): string | null {
	if (!def.steps.length && !def.variants) return 'needs at least one step, or variants';
	const dangling = danglingTransition(def);
	return idProblem(def) ?? roleProblem(def) ?? (dangling && `step transition points nowhere: ${dangling}`);
}

function schemaProblem(raw: unknown, err: z.ZodError): string {
	const id = (raw as { id?: unknown })?.id;
	const issue = err.issues[0];
	return `${typeof id === 'string' ? id : 'workflow'}: ${[...(issue?.path ?? []), issue?.message ?? 'invalid'].join(' ')}`;
}

// One user definition, or the reason it was rejected.
function parseDef(raw: unknown): { def?: WorkflowDef; problem?: string } {
	const parsed = defSchema.safeParse(raw);
	if (!parsed.success) return { problem: schemaProblem(raw, parsed.error) };
	const problem = stepProblem(parsed.data);
	return problem ? { problem: `${parsed.data.id}: ${problem}` } : { def: parsed.data };
}

// The user's definitions merged over the built-ins: a user workflow with a
// built-in's id replaces it, and one marked `default` takes the default for its
// category. A malformed entry is skipped and reported, never fatal.
export function resolveWorkflows(raw: unknown): { workflows: WorkflowDef[]; problems: string[] } {
	const list = Array.isArray((raw as { workflows?: unknown })?.workflows)
		? ((raw as { workflows: unknown[] }).workflows)
		: [];
	const builtins = new Map(BUILTIN_WORKFLOWS.map((w) => [w.id, w]));
	const byId = new Map(builtins);
	const problems: string[] = [];
	for (const item of list) {
		const { def, problem } = parseDef(item);
		if (def) byId.set(def.id, def);
		else problems.push(problem!);
	}
	// Variants are checked once every definition is in, since one may name a
	// workflow listed after it. A bad wrapper is dropped (a built-in it replaced
	// comes back); its variants stay.
	for (const def of [...byId.values()]) {
		const problem = variantProblem(def, byId);
		if (!problem) continue;
		problems.push(`${def.id}: ${problem}`);
		if (builtins.has(def.id)) byId.set(def.id, builtins.get(def.id)!);
		else byId.delete(def.id);
	}
	return { workflows: withOneDefault([...byId.values()]), problems };
}

// Why a workflow's variants can't run, or null: each must be another known
// workflow of the same category with steps of its own and no variants.
function variantProblem(def: WorkflowDef, byId: Map<string, WorkflowDef>): string | null {
	for (const id of def.variants ?? []) {
		const v = byId.get(id);
		if (!v) return `variant "${id}" is not a known workflow`;
		if (v.variants) return `variant "${id}" has variants of its own`;
		if (v.category !== def.category) return `variant "${id}" is a ${v.category} workflow, not ${def.category}`;
	}
	return null;
}

// The workflow a run on `def` actually runs: `def` itself, or one of its
// variants picked uniformly with `random` (in [0, 1)), naming `def` as what it
// is a variant of.
export function resolveVariant(
	defs: WorkflowDef[],
	def: WorkflowDef,
	random: () => number = Math.random
): { def: WorkflowDef; variantOf?: string } {
	if (!def.variants?.length) return { def };
	const id = def.variants[Math.min(def.variants.length - 1, Math.floor(random() * def.variants.length))];
	const picked = defs.find((d) => d.id === id);
	return picked ? { def: picked, variantOf: def.id } : { def };
}

// Exactly one default per category: the last one marked wins, so a user
// workflow marked default displaces the built-in. A category with none marked
// (a user def replaced the built-in without saying `default`) falls back to its
// first workflow, so the feed automation always has something to fire.
function withOneDefault(defs: WorkflowDef[]): WorkflowDef[] {
	const winner = new Map<WorkflowCategory, string>();
	for (const d of defs) if (!winner.has(d.category)) winner.set(d.category, d.id);
	const marked = new Map<WorkflowCategory, string>();
	for (const d of defs) if (d.default) marked.set(d.category, d.id);
	for (const [category, id] of marked) winner.set(category, id);
	return defs.map((d) => ({ ...d, default: winner.get(d.category) === d.id }));
}

// The workflow a start asks for: by id when given, else the category default.
export function pickWorkflow(
	defs: WorkflowDef[],
	want: { id?: string; category?: WorkflowCategory }
): WorkflowDef | undefined {
	if (want.id) return defs.find((d) => d.id === want.id);
	return defs.find((d) => d.category === (want.category ?? 'dev') && d.default);
}

// ---- Client profiles (the dev-workflow skill's clients.json) ----

export interface ClientProfile {
	prefixes?: string[];
	githubOwners?: string[];
	reviewer?: string;
	baseBranch?: string | null;
	loopDefault?: boolean;
}

export interface ResolvedProfile {
	loop: boolean;
	reviewer?: string;
	baseBranch?: string;
}

function toResolved(p: ClientProfile | undefined): ResolvedProfile {
	return { loop: !!p?.loopDefault, reviewer: p?.reviewer || undefined, baseBranch: p?.baseBranch || undefined };
}

// The profile for a run, by the same rule the skill uses: a GitHub owner maps to
// the profile listing it (else the generic `github` profile), a Linear id to the
// profile whose prefixes hold its prefix. No match runs without the post-PR loop.
export function matchProfile(
	profiles: Record<string, ClientProfile>,
	at: { owner?: string; issue?: Pick<SessionIssue, 'source' | 'id'> }
): ResolvedProfile {
	const entries = Object.values(profiles);
	if (at.issue?.source === 'linear') {
		const prefix = at.issue.id.split('-')[0];
		return toResolved(entries.find((p) => p.prefixes?.includes(prefix)));
	}
	const owner = at.owner?.toLowerCase();
	const byOwner = entries.find((p) => p.githubOwners?.some((o) => o.toLowerCase() === owner));
	return toResolved(byOwner ?? profiles.github);
}

// ---- Starting a run ----

export interface NewRunInput {
	id: string;
	def: WorkflowDef;
	projectPath: string;
	cwd: string;
	branch: string;
	base?: string;
	title: string;
	issue?: SessionIssue;
	pr?: RunPr;
	profile: ResolvedProfile;
	// The workflow that picked `def` as its variant.
	variantOf?: string;
	now: number;
}

export function newRun(input: NewRunInput): WorkflowRun {
	const { def, profile, now } = input;
	return {
		id: input.id,
		workflowId: def.id,
		workflowName: def.name,
		...(input.variantOf ? { variantOf: input.variantOf } : {}),
		category: def.category,
		steps: def.steps,
		projectPath: input.projectPath,
		cwd: input.cwd,
		branch: input.branch,
		base: input.base,
		title: input.title,
		issue: input.issue,
		pr: input.pr,
		loop: profile.loop,
		reviewer: profile.reviewer,
		status: 'running',
		phase: def.steps[0].id,
		epoch: 0,
		visits: [],
		round: 0,
		findings: [],
		escalations: { implementer: false, disagreement: false, cap: false },
		failures: {},
		humanTouched: false,
		answers: [],
		decisions: [],
		createdAt: now,
		updatedAt: now
	};
}

export function stepById(run: Pick<WorkflowRun, 'steps'>, id: string): WorkflowStep | undefined {
	return run.steps.find((s) => s.id === id);
}

export function currentStep(run: WorkflowRun): WorkflowStep | undefined {
	return stepById(run, run.phase);
}

export function isFinished(run: Pick<WorkflowRun, 'status'>): boolean {
	return FINISHED_RUN.includes(run.status);
}

function visitsOf(run: WorkflowRun, stepId: string): PhaseVisit[] {
	return run.visits.filter((v) => v.step === stepId);
}

export function lastVisit(run: WorkflowRun): PhaseVisit | undefined {
	return run.visits.at(-1);
}

// The agent a step's next visit runs on: a per-run override first, then the
// escalated implementer, then the later-round tier, then the step's own pick.
export function agentFor(run: WorkflowRun, step: WorkflowStep): StepAgent {
	const override = run.stepAgents?.[step.id];
	if (override) return override;
	if (step.role === 'fix' && run.escalations.implementer && step.escalateAgent) return step.escalateAgent;
	if (visitsOf(run, step.id).length > 0 && step.repeatAgent) return step.repeatAgent;
	return step.agent ?? {};
}

// Open a visit to `stepId` and make it the run's phase. A feedback step starts
// out waiting on the reviewer rather than running.
export function beginVisit(run: WorkflowRun, stepId: string, now: number): PhaseVisit {
	const step = stepById(run, stepId)!;
	const visit: PhaseVisit = {
		step: stepId,
		visit: visitsOf(run, stepId).length + 1,
		agent: step.skill ? agentFor(run, step) : undefined,
		startedAt: now
	};
	run.visits.push(visit);
	run.phase = stepId;
	run.status = step.role === 'feedback' ? 'waiting' : 'running';
	run.updatedAt = now;
	return visit;
}

// ---- Structured output ----

const optionalText = z.string().optional().catch(undefined);

const findingSchema = z.object({
	// Read but never trusted: the engine gives every finding its own id.
	id: optionalText,
	file: z.string(),
	line: z.number().int().optional().catch(undefined),
	// Normalised once here, so the gate, the digest, and the prompts all compare
	// the same `blocker`.
	severity: z.string().transform((s) => s.toLowerCase()),
	defect: z.string(),
	scenario: optionalText,
	via: optionalText,
	fix: optionalText,
	keep: optionalText
});

// `not fixed`, `Not-Fixed` and `not_fixed` all read the same.
const status = z.string().transform((s) => s.trim().toLowerCase().replace(/[\s-]+/g, '_'));

// A checklist item as a phase reports it: implement writes `text`, review and
// the PR phase give `status` and `evidence`.
const acceptanceSchema = z.object({
	id: z.string().transform((s) => s.trim().toUpperCase()),
	text: optionalText,
	status: status
		.transform((s) => (s === 'not_met' ? 'unmet' : s))
		.pipe(z.enum(['met', 'unmet', 'not_verifiable']))
		.optional()
		.catch(undefined),
	evidence: optionalText
});

export type AcceptanceReport = z.infer<typeof acceptanceSchema>;

// Each entry parsed alone, so one malformed entry drops only itself.
function lenientArray<T extends z.ZodTypeAny>(item: T) {
	return z
		.array(z.unknown())
		.transform((list) => list.flatMap((v) => {
			const parsed = item.safeParse(v);
			return parsed.success ? [parsed.data as z.infer<T>] : [];
		}))
		.optional()
		.catch(undefined);
}

const verificationSchema = z.object({
	id: z.string(),
	status: status.pipe(z.enum(['fixed', 'not_fixed', 'regressed'])),
	evidence: z.string().catch('')
});

const fixReportSchema = z.object({
	finding: z.string().catch(''),
	change: z.string().catch(''),
	evidence: z.string().catch('')
});

const coverageSchema = z.object({
	examined: z.array(z.string()).catch([]),
	notExamined: z.array(z.string()).catch([])
});

// What a phase's closing ```json block can carry. Every field is optional; the
// role decides which ones it needs.
export interface Structured {
	findings?: Finding[];
	verifications?: Verification[];
	acceptance?: AcceptanceReport[];
	coverage?: Coverage;
	disagreements?: string[];
	fixes?: FixReport[];
	dismissed?: boolean;
	reason?: string;
}

// At least one known key, so an unrelated JSON snippet quoted last in a reply
// can't stand in for the real verdict block above it.
const structuredSchema = z
	.object({
		findings: z.array(findingSchema).optional(),
		verifications: lenientArray(verificationSchema),
		acceptance: lenientArray(acceptanceSchema),
		coverage: coverageSchema.optional(),
		disagreements: z.array(z.string()).optional(),
		// Never fails the block: a malformed report must not lose the disagreements beside it.
		fixes: z.array(fixReportSchema).optional().catch(undefined),
		dismissed: z.boolean().optional(),
		reason: z.string().optional()
	})
	.refine((o) => Object.keys(o).length > 0);

const FENCE = /```json\s*\n([\s\S]*?)\n\s*```/g;

// The last ```json block in a phase's final reply that parses into the
// structured shape, or null when there is none. The last one wins so a reply
// that quotes an example earlier still reads its real verdict.
export function parseStructured(text: string | null | undefined): Structured | null {
	if (!text) return null;
	const blocks = [...text.matchAll(FENCE)].map((m) => m[1]).reverse();
	for (const block of blocks) {
		const parsed = structuredSchema.safeParse(safeJson(block));
		if (parsed.success) return parsed.data;
	}
	return null;
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function blockerCount(findings: Finding[]): number {
	return findings.filter((f) => f.severity === 'blocker').length;
}

// ---- The transition function ----

// What a finished visit produced, as the runner computed it.
export interface GateResult {
	pass: boolean;
	// Passed because there was nothing to check (a repo with no test command).
	skipped?: boolean;
	// The step could not produce a verdict at all (a crashed turn, a missing
	// structured block, a gh error). Retried, then the run blocks.
	error?: string;
	detail?: string;
	structured?: Structured;
	// A verify step's output, handed to the fix phase when it is red.
	output?: string;
	// The step found a reason to stop for a person: no retry, no failure path.
	block?: { question: string; kind?: RunBlockKind };
}

// What the runner must do next.
export type Effect = { type: 'enter'; step: string } | { type: 'wait' } | { type: 'block' } | { type: 'done' };

const VERIFY_RED_CAP = 3;

function decide(run: WorkflowRun, step: string, action: string, reason: string, now: number): void {
	run.decisions.push({ at: now, by: 'engine', step, action, reason });
}

export function blockRun(
	run: WorkflowRun,
	step: string,
	question: string,
	now: number,
	by: 'engine' | 'overseer' | 'human' = 'engine',
	kind?: RunBlockKind
): Effect {
	run.status = 'blocked';
	run.block = { question, at: now, by, step, ...(kind ? { kind } : {}) };
	run.updatedAt = now;
	return { type: 'block' };
}

// Move to `target`, ending the run on DONE. The feedback step is skipped when
// the client profile has the post-PR loop off.
function goTo(run: WorkflowRun, target: string, now: number): Effect {
	const step = target === DONE ? undefined : stepById(run, target);
	if (step?.role === 'feedback' && !run.loop) return goTo(run, step.next, now);
	if (target === DONE) {
		run.status = 'done';
		run.updatedAt = now;
		return { type: 'done' };
	}
	if (!step) return blockRun(run, run.phase, `The workflow has no step "${target}".`, now);
	return { type: 'enter', step: target };
}

function failTo(run: WorkflowRun, step: WorkflowStep, reason: string, now: number): Effect {
	if (step.onFail) return goTo(run, step.onFail, now);
	return blockRun(run, step.id, reason, now);
}

function passOrFail(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (result.pass) return goTo(run, step.next, now);
	return failTo(run, step, `${step.label} did not pass: ${result.detail ?? 'gate failed'}`, now);
}

function onVerify(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	const key = `${step.id}#red`;
	if (result.pass) {
		run.verifyOutput = undefined;
		run.failures[key] = 0;
		return goTo(run, step.next, now);
	}
	run.verifyOutput = result.output;
	run.failures[key] = (run.failures[key] ?? 0) + 1;
	if (run.failures[key] >= VERIFY_RED_CAP) {
		return blockRun(run, step.id, `${step.label} stayed red after ${VERIFY_RED_CAP} fix attempts.`, now);
	}
	return failTo(run, step, `${step.label} failed.`, now);
}

function stepWithRole(run: WorkflowRun, role: WorkflowStep['role']): WorkflowStep | undefined {
	return run.steps.find((s) => s.role === role);
}

// Blockers still standing at the round cap get one top-tier closer, then the
// run blocks for a person.
function onReviewCap(run: WorkflowRun, step: WorkflowStep, blockers: number, now: number): Effect {
	const closer = stepWithRole(run, 'closer');
	if (closer && !run.escalations.cap) {
		run.escalations.cap = true;
		decide(run, step.id, 'escalate', `${blockers} blockers still standing after ${run.round} rounds; one pass at the top tier.`, now);
		return goTo(run, closer.id, now);
	}
	return blockRun(run, step.id, `${blockers} blockers still standing after ${run.round} review rounds.`, now);
}

// ---- Findings across rounds ----

function idNumber(id: string | undefined): number {
	return /^F(\d+)$/.exec(id ?? '')?.[1] ? Number(id!.slice(1)) : 0;
}

// The next run-scoped finding id. A run stored before `findingSeq` existed
// starts after the highest id it already holds.
function nextFindingId(run: WorkflowRun): string {
	const held = [...run.findings, ...(run.pastFindings ?? []), ...(run.followUps ?? [])];
	const seq = run.findingSeq ?? Math.max(0, ...held.map((f) => idNumber(f.id)));
	run.findingSeq = seq + 1;
	return `F${run.findingSeq}`;
}

// Give every finding of the run an id, in place.
function ensureFindingIds(run: WorkflowRun): void {
	for (const f of run.findings) if (!f.id) f.id = nextFindingId(run);
}

// The blockers a round left open: review findings and unmet acceptance items.
export function openFindings(run: WorkflowRun): Finding[] {
	ensureFindingIds(run);
	return run.findings.filter((f) => f.severity === 'blocker');
}

function isAcceptanceId(id: string | undefined): boolean {
	return /^A\d+$/.test(id ?? '');
}

// The review findings a later round checks by id. Unmet acceptance items are
// not among them: every round reports the whole checklist again.
function openReviewFindings(run: WorkflowRun): Finding[] {
	return openFindings(run).filter((f) => !isAcceptanceId(f.id));
}

// ---- The acceptance checklist ----

// Take the statuses a phase reported for the run's checklist items. Unknown ids
// are ignored; an item not reported keeps its last status.
export function applyAcceptance(run: WorkflowRun, reported: AcceptanceReport[] | undefined): void {
	for (const r of reported ?? []) {
		const item = run.acceptance?.find((a) => a.id === r.id);
		if (item && r.status) Object.assign(item, { status: r.status, evidence: r.evidence });
	}
}

// Implement wrote the checklist the issue lacked. Renumbered, so the ids are
// the engine's whatever the agent called them.
function takeWrittenChecklist(run: WorkflowRun, reported: AcceptanceReport[] | undefined): void {
	if (run.acceptance?.length) return;
	const written = (reported ?? []).map((r) => r.text?.trim() ?? '').filter(Boolean);
	if (written.length) run.acceptance = written.map((text, i) => ({ id: `A${i + 1}`, text }));
}

// An unmet item as a blocker the fix phase gets, under the item's own id.
function unmetFindings(run: WorkflowRun): Finding[] {
	return (run.acceptance ?? [])
		.filter((a) => a.status === 'unmet')
		.map((a) => ({
			id: a.id,
			file: 'acceptance',
			severity: 'blocker',
			defect: `Acceptance item ${a.id} is not met: ${a.text}`,
			...(a.evidence ? { fix: a.evidence } : {})
		}));
}

// The checklist items the PR gate would not pass: any not reported met, unless
// the owner accepted them. Nothing to check on a run without a checklist.
export function acceptanceGaps(run: WorkflowRun, reported: AcceptanceReport[] | undefined): { id: string; text: string; status?: string }[] {
	if (!run.acceptance?.length || run.acceptanceOverride) return [];
	const byId = new Map((reported ?? []).map((r) => [r.id, r.status]));
	return run.acceptance
		.filter((a) => byId.get(a.id) !== 'met')
		.map((a) => ({ id: a.id, text: a.text, status: byId.get(a.id) }));
}

// Why the PR gate stops for the owner, naming the unmet items and whether a PR
// went up regardless.
export function acceptanceBlock(gaps: { id: string; text: string; status?: string }[], prUrl: string | null): string {
	return [
		'Acceptance items not met:',
		...gaps.map((g) => `- ${g.id} (${g.status ?? 'no status reported'}): ${g.text}`),
		prUrl ? `A PR was opened anyway: ${prUrl}` : 'No PR was opened.',
		'Resume to accept them and go on, or resume at another step to finish them.'
	].join('\n');
}

// The owner resumed past unmet items and the PR is linked: go on past the PR step.
export function acceptOverride(run: WorkflowRun, now: number): Effect {
	const step = currentStep(run)!;
	decide(run, step.id, 'accept-unmet', `The owner accepted unmet acceptance items: ${run.acceptanceOverride?.ids.join(', ') || 'none'}.`, now);
	return goTo(run, step.next, now);
}

// A delta entry (`src/a.ts:L4-6,L9`) as its file and line ranges.
function parseDelta(entry: string): { file: string; ranges: [number, number][] } {
	const at = entry.lastIndexOf(':');
	const ranges = entry
		.slice(at + 1)
		.split(',')
		.map((r) => r.replace(/^L/, '').split('-').map(Number))
		.filter((r) => r.every(Number.isFinite))
		.map(([a, b]) => [a, b ?? a] as [number, number]);
	return { file: entry.slice(0, at), ranges };
}

function inRanges(delta: string[], file: string, line: number | undefined): boolean {
	return delta.some((entry) => {
		const d = parseDelta(entry);
		return d.file === file && (line === undefined || d.ranges.some(([a, b]) => line >= a && line <= b));
	});
}

// `src/a.ts:12` (or `src/a.ts:L12`) as a file and line.
function location(ref: string): { file: string; line?: number } {
	const m = /^(.*):L?(\d+)$/.exec(ref.trim());
	return m ? { file: m[1], line: Number(m[2]) } : { file: ref.trim() };
}

// Why a new blocker in round 2+ does not count, or null when it does: it must
// give a failing scenario and sit in what this round was asked to read (the
// changed ranges, a direct caller of them named by `via`, or a file an earlier
// round skipped). Without a delta to compare against, scope is not judged.
function newBlockerProblem(f: Finding, delta: string[] | undefined, skipped: string[]): string | null {
	if (!f.scenario?.trim()) return 'no failing scenario';
	if (!delta?.length) return null;
	if (inRanges(delta, f.file, f.line) || skipped.includes(f.file)) return null;
	const via = f.via ? location(f.via) : null;
	if (via && inRanges(delta, via.file, via.line)) return null;
	return 'outside the changed ranges and their direct callers';
}

// The last round's open findings as this round judged them: the ones still
// open (no verdict counts as not fixed, so a blocker is never dropped by
// omission) and the ones fixed.
function checkPrior(prior: Finding[], verifications: Verification[]): { open: Finding[]; fixed: Finding[] } {
	const byId = new Map(verifications.map((v) => [v.id, v]));
	const open: Finding[] = [];
	const fixed: Finding[] = [];
	for (const f of prior) {
		const v = byId.get(f.id!);
		if (v?.status === 'fixed') fixed.push(f);
		else open.push({ ...f, verification: { status: v?.status ?? 'not_fixed', evidence: v?.evidence ?? 'not checked by the review' } });
	}
	return { open, fixed };
}

// This round's new findings, each with its own id. From round 2 on, a blocker
// that fails newBlockerProblem becomes a nit and is kept for a follow-up issue.
function judgeNew(run: WorkflowRun, stepId: string, raw: Finding[], delta: string[] | undefined, now: number): Finding[] {
	const skipped = (run.coverage?.notExamined ?? []).map((s) => s.split(':')[0].trim());
	const downgraded: string[] = [];
	const out = raw.map((f) => {
		const finding = { ...f, id: nextFindingId(run) };
		if (run.round < 2 || finding.severity !== 'blocker') return finding;
		const problem = newBlockerProblem(finding, delta, skipped);
		if (!problem) return finding;
		const nit = { ...finding, severity: 'nit' };
		run.followUps = [...(run.followUps ?? []), nit];
		downgraded.push(`${finding.id} (${problem})`);
		return nit;
	});
	if (downgraded.length) decide(run, stepId, 'downgrade', `New blockers kept for a follow-up issue as nits: ${downgraded.join(', ')}.`, now);
	return out;
}

// Record a review round: the last round's open findings are checked by id
// (fixed ones go into history), new ones get ids, and the round's blockers are
// the ones still open plus the new blockers that count.
function recordRound(run: WorkflowRun, step: WorkflowStep, structured: Structured | undefined, now: number): { blockers: number; stillOpen: string[] } {
	const prior = run.round > 0 ? openReviewFindings(run) : [];
	const wasUnmet = new Set(run.round > 0 ? openFindings(run).filter((f) => isAcceptanceId(f.id)).map((f) => f.id!) : []);
	run.round += 1;
	run.verifyOutput = undefined;
	const visit = lastVisit(run);
	run.reviewTree = visit?.tree ?? run.reviewTree;
	const { open, fixed } = checkPrior(prior, structured?.verifications ?? []);
	run.pastFindings = [...(run.pastFindings ?? []), ...fixed].slice(-50);
	applyAcceptance(run, structured?.acceptance);
	const unmet = unmetFindings(run);
	run.findings = [...open, ...unmet, ...judgeNew(run, step.id, structured?.findings ?? [], visit?.delta, now)];
	run.coverage = structured?.coverage;
	const stillOpen = [...open.map((f) => f.id!), ...unmet.map((f) => f.id!).filter((id) => wasUnmet.has(id))];
	return { blockers: blockerCount(run.findings), stillOpen };
}

// Two or more blockers in round 1 prove the task needed the stronger implementer.
function maybeEscalateImplementer(run: WorkflowRun, step: WorkflowStep, blockers: number, now: number): void {
	if (run.round !== 1 || blockers < 2 || run.escalations.implementer) return;
	run.escalations.implementer = true;
	decide(run, step.id, 'escalate', `Round 1 found ${blockers} blockers; fixes move to the stronger implementer.`, now);
}

function describeFinding(f: Finding): string {
	return `${f.id} (${f.file}${f.line ? `:${f.line}` : ''}): ${f.defect}`;
}

// A finding reported still open in two rounds running moves the next fix to
// the step's escalateAgent; still open after that fix, the run stops for the
// owner. Only consecutive rounds count: a finding fixed once starts over.
function trackStuck(run: WorkflowRun, step: WorkflowStep, stillOpen: string[], now: number): Effect | null {
	const streak: Record<string, number> = {};
	for (const id of stillOpen) streak[id] = (run.openStreak?.[id] ?? 0) + 1;
	run.openStreak = streak;
	const named = (ids: string[]) => run.findings.filter((f) => ids.includes(f.id!));
	const stuck = named(stillOpen.filter((id) => streak[id] >= 3));
	if (stuck.length) {
		const list = stuck.map(describeFinding).join('\n');
		return blockRun(run, step.id, `Still not fixed after an escalated fix:\n${list}\nFix it by hand or answer how, then resume.`, now);
	}
	const due = named(stillOpen.filter((id) => streak[id] === 2));
	if (!due.length) return null;
	const already = run.escalations.implementer;
	run.escalations.implementer = true;
	const ids = due.map((f) => f.id).join(', ');
	decide(run, step.id, 'escalate', `${ids} not fixed in two rounds running; ${already ? 'the next fix is already at' : 'the next fix moves to'} the stronger implementer.`, now);
	return null;
}

function onReview(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	const { blockers, stillOpen } = recordRound(run, step, result.structured, now);
	// The gate counted the raw block; the round's real count is the engine's.
	const visit = lastVisit(run);
	if (visit) Object.assign(visit, { result: blockers ? 'fail' : 'pass', detail: `${blockers} blockers, ${run.findings.length} findings` });
	maybeEscalateImplementer(run, step, blockers, now);
	const stuck = trackStuck(run, step, stillOpen, now);
	if (stuck) return stuck;
	if (blockers === 0) return goTo(run, step.next, now);
	if (run.round >= (step.cap ?? REVIEW_ROUND_CAP)) return onReviewCap(run, step, blockers, now);
	return failTo(run, step, `${blockers} blockers.`, now);
}

// A follow-up fix ends the run again once its commit is pushed.
function onFollowUp(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (!result.pass) return blockRun(run, step.id, `The follow-up fix did not land: ${result.detail ?? 'no pushed commit'}`, now);
	decide(run, step.id, 'follow-up', `Leftover findings addressed in ${result.detail ?? 'a pushed commit'}.`, now);
	run.followUp = undefined;
	run.findings = [];
	return goTo(run, DONE, now);
}

// A fix that would undo what an earlier round demanded goes to the arbiter once;
// a second disagreement goes to a person.
function onFix(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (result.structured?.fixes?.length) run.fixes = result.structured.fixes;
	if (run.followUp) return onFollowUp(run, step, result, now);
	const disagreements = result.structured?.disagreements ?? [];
	if (!disagreements.length) return passOrFail(run, step, result, now);
	run.disagreement = disagreements.join('\n');
	const arbiter = stepWithRole(run, 'arbiter');
	if (arbiter && !run.escalations.disagreement) {
		run.escalations.disagreement = true;
		decide(run, step.id, 'escalate', 'A review round asked to undo an earlier fix; one ruling at the top tier.', now);
		return goTo(run, arbiter.id, now);
	}
	return blockRun(run, step.id, `Review rounds disagree:\n${run.disagreement}`, now);
}

// The closer either fixed the blockers (verify, then one final review round) or
// ruled them invalid. A ruling waives a review's blockers, so the owner makes
// the call: the run blocks with the closer's reason, and resuming accepts it.
function onCloser(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (!result.structured?.dismissed) return passOrFail(run, step, result, now);
	const reason = result.structured.reason ?? 'no reason given';
	decide(run, step.id, 'dismiss-proposed', reason, now);
	const question = `The closer ruled the standing blockers invalid: ${reason}\nResume to accept that and open the PR, or resume at another step.`;
	return blockRun(run, step.id, question, now, 'engine', 'closer-dismissed');
}

// The owner resumed a closer's dismissal: drop the blockers and go on past
// review, as a dismissal did before it stopped for a person.
export function acceptDismissal(run: WorkflowRun, now: number): Effect {
	const step = currentStep(run)!;
	decide(run, step.id, 'dismiss', 'The owner accepted the closer\'s dismissal of the standing blockers.', now);
	run.findings = [];
	const review = stepWithRole(run, 'review');
	return goTo(run, review?.next ?? step.next, now);
}

// The reviewer loop ends when the PR is approved with nothing open (or merged);
// otherwise the run waits for the reviewer's next pass.
function onFeedback(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	if (result.pass) return goTo(run, step.next, now);
	if (visitsOf(run, step.id).length >= (step.cap ?? FEEDBACK_ROUND_CAP)) {
		return blockRun(run, step.id, `Reviewer feedback still open after ${step.cap ?? FEEDBACK_ROUND_CAP} rounds.`, now);
	}
	run.status = 'waiting';
	return { type: 'wait' };
}

function onImplement(run: WorkflowRun, step: WorkflowStep, result: GateResult, now: number): Effect {
	takeWrittenChecklist(run, result.structured?.acceptance);
	return passOrFail(run, step, result, now);
}

const HANDLERS: Partial<Record<WorkflowStep['role'], typeof passOrFail>> = {
	implement: onImplement,
	verify: onVerify,
	review: onReview,
	fix: onFix,
	closer: onCloser,
	feedback: onFeedback
};

// A visit that produced no verdict: retry the same step, then block.
function onError(run: WorkflowRun, step: WorkflowStep, error: string, now: number): Effect {
	run.failures[step.id] = (run.failures[step.id] ?? 0) + 1;
	if (run.failures[step.id] <= (step.retries ?? 1)) {
		decide(run, step.id, 'retry', error, now);
		return { type: 'enter', step: step.id };
	}
	return blockRun(run, step.id, `${step.label} failed: ${error}`, now);
}

function closeVisit(run: WorkflowRun, result: GateResult, now: number): void {
	const visit = lastVisit(run);
	if (!visit || visit.endedAt) return;
	visit.endedAt = now;
	visit.result = result.error ? 'error' : result.skipped ? 'skipped' : result.pass ? 'pass' : 'fail';
	visit.detail = result.error ?? result.block?.question ?? result.detail;
}

// Record a finished visit and decide what happens next. Mutates `run`.
export function advance(run: WorkflowRun, result: GateResult, now: number): Effect {
	const step = currentStep(run);
	if (!step) return blockRun(run, run.phase, `The workflow has no step "${run.phase}".`, now);
	closeVisit(run, result, now);
	run.updatedAt = now;
	if (result.block) return blockRun(run, step.id, result.block.question, now, 'engine', result.block.kind);
	if (result.error) return onError(run, step, result.error, now);
	run.failures[step.id] = 0;
	return (HANDLERS[step.role] ?? passOrFail)(run, step, result, now);
}

// ---- How a phase ended ----

export const USAGE_LIMIT_BLOCK = 'agent hit its usage limit; resume when it resets';

const USAGE_LIMIT = /usage limit|(?:session|weekly|daily|5-hour|opus|plan) limit reached|hit your (?:\w+ )?limit|rate[ _-]?limit(?:ed| exceeded| error)|insufficient_quota|exceeded your current quota|\brate_limit(?:_error)?\b|too many requests|api error: 429|http 429|status(?: code)?:? 429/i;

// Whether a turn's error text (see lastTurnErrors) says the agent ran out of its
// account's usage or was rate limited: waiting fixes that, a retry does not.
export function usageLimitHit(errors: string): boolean {
	return USAGE_LIMIT.test(errors);
}

export const VERIFY_INFRA_RETRIES = 2;

// Why a red verify run says nothing about the code, or null for a real failure:
// the run was killed or ran out of memory, or it timed out (deck's own verify
// timeout, or test-slot's exit 124). Rerun those; don't send them to a fix.
export function verifyInfraFailure(code: number, output: string, timedOut = false): string | null {
	if (code === 0) return null;
	if (timedOut) return 'the verify command timed out';
	if (code === 124) return 'the test slot timed out (exit 124)';
	if (/JavaScript heap out of memory|\bENOMEM\b/.test(output)) return 'out of memory';
	if (code === 137 || /(^|\s)Killed(\s|$)/.test(output)) return `killed (exit ${code})`;
	return null;
}

export function verifyInfraBlock(reason: string): string {
	return `tests keep failing for infrastructure reasons: ${reason}`;
}

// ---- Before a review round ----

// The visit before the current one, skipping verify, came from the fix step.
function cameFromFix(run: WorkflowRun): boolean {
	const earlier = run.visits
		.slice(0, -1)
		.reverse()
		.find((v) => stepById(run, v.step)?.role !== 'verify');
	return !!earlier && stepById(run, earlier.step)?.role === 'fix';
}

// Why a review round about to start would examine nothing new, or null when it
// has something to read. `baseTree` is the base branch's tree at the merge
// base, null when it could not be read.
export function unchangedReviewReason(run: WorkflowRun, tree: string, baseTree: string | null): string | null {
	if (baseTree && tree === baseTree) return 'Implement produced no changes: the worktree matches the base branch, so there is nothing to review.';
	if (run.reviewTree && tree === run.reviewTree && cameFromFix(run)) {
		return 'The fix changed nothing: the worktree is the same tree the last review examined.';
	}
	return null;
}

// ---- Before implement: is the issue one run's worth? ----

const ISSUE_ITEM_CAP = 10;
const ISSUE_BODY_CAP = 12_000;

const MAX_SCANNED_LINE = 500;
const ASK_HEADING = /requirement|acceptance|\bask\b|\bscope\b|what to do/i;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;

// A heading's text, or null. String operations on a trimmed, length-capped line,
// so a hostile issue body cannot make a regex backtrack.
function headingText(line: string): string | null {
	const t = line.trim();
	if (t.startsWith('#')) {
		const text = t.replace(/^#{1,6}/, '');
		return text !== t && text.startsWith(' ') ? text.replace(/#+$/, '').trim() : null;
	}
	for (const mark of ['**', '__']) {
		const inner = t.endsWith(':') ? t.slice(0, -1).trimEnd() : t;
		if (inner.length > 4 && inner.startsWith(mark) && inner.endsWith(mark)) return inner.slice(2, -2).trim();
	}
	return null;
}

// The list items under headings that read as what the issue asks for
// (Requirements, Acceptance, Ask, Scope, What to do; "Out of scope" excluded),
// as text without their list or checkbox marker.
function issueAskList(body: string): string[] {
	let counting = false;
	const items: string[] = [];
	for (const line of body.split('\n')) {
		if (line.length > MAX_SCANNED_LINE) continue;
		const heading = headingText(line);
		const t = line.trimStart();
		if (heading !== null) counting = ASK_HEADING.test(heading) && !/out of scope/i.test(heading);
		else if (counting && LIST_ITEM.test(t)) items.push(t.replace(LIST_ITEM, '').replace(/^\[[ xX]\]\s*/, '').trim());
	}
	return items;
}

export function issueAskItems(body: string): number {
	return issueAskList(body).length;
}

// The run's acceptance checklist from the issue's own text, numbered A1, A2, ...
// Empty when the issue has no such list (implement then writes one).
export function acceptanceFromIssue(issue: IssueText | undefined): AcceptanceItem[] {
	return issueAskList(issue?.issueBody ?? '')
		.filter(Boolean)
		.map((text, i) => ({ id: `A${i + 1}`, text }));
}

// Why the issue looks too big for one run, or null. Only the issue's own text
// counts: a run with none is never stopped here.
export function issueSizeProblem(issue: IssueText | undefined): string | null {
	const body = issue?.issueBody ?? '';
	if (!body.trim()) return null;
	// Over the body cap the issue is flagged on length alone; the scan is skipped.
	const items = body.length > ISSUE_BODY_CAP ? 0 : issueAskItems(body);
	if (items <= ISSUE_ITEM_CAP && body.length <= ISSUE_BODY_CAP) return null;
	return [
		body.length > ISSUE_BODY_CAP ? 'This issue looks too big for one run:' : `This issue looks too big for one run: ${items} list items under requirement headings (limit ${ISSUE_ITEM_CAP}),`,
		`${body.length} characters in its body (limit ${ISSUE_BODY_CAP}).`,
		'Split this issue, or resume to run it anyway.'
	].join(' ');
}

// ---- Phase prompts ----

export interface PromptContext {
	// Round 2+ review scope as file ranges.
	delta?: string[];
	// The diff a review round examines, already capped (see capDiff).
	diff?: CappedDiff;
	// The issue's own text, fetched once when the phase starts (see
	// server/issues/prompt.ts). Handed to the phase so it reads the issue from
	// the prompt rather than spending a tool call and its tokens fetching what
	// deck already has. Absent for a run with no issue, or when the fetch failed.
	issue?: IssueText;
}

// What an issue says, as the prompt renders it. Mirrors IssuePromptContext in
// server/issues/detail.ts, kept structural so this node-free module doesn't
// depend on the fetcher.
export interface IssueText {
	issueTitle?: string;
	issueBody?: string;
	issueComments?: string;
	warnings?: string[];
}

const trimmed = (v: string | undefined) => (v ?? '').trim();

// Why the issue's text is missing, so a phase doesn't read an empty block as an
// empty issue. Nothing when the fetch simply wasn't asked for.
function issueUnreadable(issue: IssueText, run: WorkflowRun): string {
	if (!issue.warnings?.length) return '';
	return `Could not read ${issueRef(run)}: ${issue.warnings.join('; ')}`;
}

// The issue's text as a block the phase can read. Bounded by the fetcher, not
// here.
function issueBlock(ctx: PromptContext, run: WorkflowRun): string {
	const issue = ctx.issue;
	if (!issue) return '';
	const title = trimmed(issue.issueTitle);
	const body = trimmed(issue.issueBody);
	const comments = trimmed(issue.issueComments);
	if (!title && !body && !comments) return issueUnreadable(issue, run);
	return [
		`${issueRef(run)}${title ? ` — ${title}` : ''}`,
		body,
		comments && `Comments:\n${comments}`,
		'That is the issue in full, already fetched. Do not go and read it again.'
	]
		.filter(Boolean)
		.join('\n\n');
}

// What a review round returns. From round 2 on it also checks each finding the
// last round left open, by id.
function findingsContract(later: boolean, checklist: boolean): string {
	const verifications = '"verifications":[{"id":"F1","status":"fixed|not_fixed|regressed","evidence":"what in the code shows it"}],\n ';
	const acceptance = ' "acceptance":[{"id":"A1","status":"met|unmet|not_verifiable","evidence":"file:line, test, or why it cannot be checked"}],';
	return [
		'End your reply with one fenced ```json block, exactly this shape, so the workflow can read the verdict:',
		`{${later ? verifications : ''}"findings":[{"file":"path","line":1,"severity":"blocker|nit","defect":"...","scenario":"input or steps, and the wrong result","fix":"...","keep":"..."}],`,
		...(checklist ? [acceptance] : []),
		' "coverage":{"examined":["path"],"notExamined":["path: why"]}}',
		'Use severity "blocker" only for what must change before this ships. An empty findings list means clean.',
		...(later ? ['Give one verification for every finding id listed above. Do not report an open finding again as a new one.'] : [])
	].join('\n');
}

const PHASE_NOTE = 'This session is one phase of a deck workflow run. Another phase does the next step; stop when yours is done.';
// Tests run once per round, in the verify step, so the shared test machine
// is not busy re-testing the same code from every phase (issue #408).
const EDIT_TEST_NOTE =
	'Do not run the full test suite or a whole backend or frontend suite: the Tests step runs them next. To check your work, run at most a type check and the single test file you changed.';
// Implement checks its own work once at the end, in the session that already has
// the context: a red Tests step costs a whole Fix session that starts cold.
const IMPLEMENT_TEST_NOTE =
	'When the change is done, run the repo\'s fast test command once through test-slot (`npm test` when its script already uses test-slot, otherwise `test-slot npm test`) and fix what fails in this session. Never run the full suite (`test:full`) or a whole backend or frontend suite; the Tests step runs next.';
const REVIEW_TEST_NOTE =
	'Run no tests: the Tests step already ran them and they passed. Do not start background jobs, and never end your turn while waiting on one.';

function issueRef(run: WorkflowRun): string {
	return run.issue?.url || run.issue?.id || run.title;
}

function skillLine(step: WorkflowStep, args: string): string {
	return [`/${step.skill ?? ''}`, step.args, args].filter(Boolean).join(' ');
}

function asJson(value: unknown): string {
	return '```json\n' + JSON.stringify(value, null, 1) + '\n```';
}

// The run's acceptance checklist with its ids, and what the phase does with it.
function checklistBlock(run: WorkflowRun, task: string): string {
	if (!run.acceptance?.length) return '';
	return ['Acceptance checklist for this run:', ...run.acceptance.map((a) => `- ${a.id}: ${a.text}`), task].join('\n');
}

const WRITE_CHECKLIST =
	'The issue has no acceptance list the workflow could read. Write one from the issue: each thing the change must do, one checkable item each. End your reply with a fenced ```json block: {"acceptance":[{"id":"A1","text":"..."}]}.';

function implementPrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext): string[] {
	const issue = issueBlock(ctx, run);
	return [
		skillLine(step, `${issueRef(run)} base-branch=${run.base ?? ''}`.trim()),
		PHASE_NOTE,
		issue,
		issue
			? 'Run the skill as far as writing tests and no further: implement what the issue above asks for and add tests.'
			: 'Run the skill as far as writing tests and no further: read the issue, implement, and add tests.',
		run.acceptance?.length ? checklistBlock(run, 'Meet every item; review checks each one by its id.') : WRITE_CHECKLIST,
		IMPLEMENT_TEST_NOTE,
		'You are already on the run\'s branch and worktree; do not create another. Do not commit, do not run the review loop, and do not open a PR.'
	];
}

function reviewScope(run: WorkflowRun, ctx: PromptContext): string {
	if (run.round === 0 || !ctx.delta?.length) {
		return `Scope: the whole branch diff against ${run.base ?? 'the base branch'}, including uncommitted changes.`;
	}
	const skipped = run.coverage?.notExamined ?? [];
	return [
		'Scope: these ranges and the callers and consumers of what they touch:',
		...ctx.delta.map((d) => `- ${d}`),
		...(skipped.length ? ['Also read these, which an earlier pass did not examine:', ...skipped.map((d) => `- ${d}`)] : [])
	].join('\n');
}

export const REVIEW_DIFF_CAP = 60_000;

export interface CappedDiff {
	text: string;
	// Files whose diff did not fit, by name.
	omitted: string[];
	truncated: boolean;
}

function diffFile(section: string): string {
	const header = section.split('\n', 1)[0];
	return /^diff --git a\/.* b\/(.*)$/.exec(header)?.[1] ?? header.replace(/^diff --git /, '');
}

// A diff cut to about `cap` characters at file boundaries. Files that don't fit
// are listed by name; a first file too big on its own is cut mid-way.
export function capDiff(diff: string, cap = REVIEW_DIFF_CAP): CappedDiff {
	const sections = diff.split(/^(?=diff --git )/m).filter(Boolean);
	let text = '';
	let i = 0;
	for (; i < sections.length && text.length + sections[i].length <= cap; i++) text += sections[i];
	if (i === sections.length) return { text, omitted: [], truncated: false };
	if (!text) text = sections[i++].slice(0, cap);
	return { text, omitted: sections.slice(i).map(diffFile), truncated: true };
}

// A fence longer than any backtick run inside the diff, so a markdown file in
// it can't close the block early.
function fenceFor(text: string): string {
	const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
	return '`'.repeat(Math.max(3, longest + 1));
}

function reviewDiffBlock(run: WorkflowRun, ctx: PromptContext): string {
	const diff = ctx.diff;
	if (!diff?.text.trim()) return '';
	const what = run.round === 0 || !ctx.delta?.length
		? `The branch diff against ${run.base ?? 'the base branch'}, uncommitted changes included`
		: 'What changed since the last review round';
	const fence = fenceFor(diff.text);
	const cut = diff.truncated
		? [
				`The diff above is cut at about ${REVIEW_DIFF_CAP.toLocaleString('en-US')} characters.${diff.omitted.length ? ' These files changed too and are not shown; read their diffs yourself:' : ''}`,
				...diff.omitted.map((f) => `- ${f}`)
			].join('\n')
		: '';
	return [`${what}, so you do not need to run git diff for it:`, `${fence}diff\n${diff.text.replace(/\n$/, '')}\n${fence}`, cut]
		.filter(Boolean)
		.join('\n');
}

// Round 2+: what the last round left open, to check by id, and the bar a new
// blocker has to clear.
function priorFindingsBlock(run: WorkflowRun): string {
	if (run.round === 0) return '';
	const prior = openReviewFindings(run).map(({ id, file, line, defect, fix }) => ({ id, file, line, defect, fix }));
	return [
		...(prior.length
			? ['The last round left these findings open. Check each one against the code now and report it under "verifications":', asJson(prior)]
			: []),
		'A new blocker counts only if it gives a concrete failing "scenario" (the input or steps, and the wrong result) and sits in the scope above: the changed ranges, a direct caller of them (name the changed file:line it calls in "via"), or a file listed as not examined. Anything else is a nit, kept for a follow-up issue.'
	].join('\n');
}

function reviewPrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext): string[] {
	return [
		skillLine(step, ''),
		PHASE_NOTE,
		'You did not write this code. Do not edit anything; return findings only.',
		REVIEW_TEST_NOTE,
		`The change is for ${issueRef(run)}; judge it against that issue's acceptance criteria.`,
		issueBlock(ctx, run),
		reviewScope(run, ctx),
		reviewDiffBlock(run, ctx),
		priorFindingsBlock(run),
		checklistBlock(run, 'Report every item of this checklist under "acceptance" as met, unmet, or not_verifiable, with evidence. An unmet item is a blocker; do not repeat it as a finding.'),
		findingsContract(run.round > 0, !!run.acceptance?.length)
	];
}

// A finished run reopened to clear what the review let through. The PR is
// already open, so this session commits and pushes to it itself.
function followUpPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		`The PR for this work is open: ${run.pr?.url ?? `${run.pr?.repo}#${run.pr?.number}`}. Its review passed, but left these findings:`,
		asJson(run.findings),
		"Address each one in the working tree. Treat a suggested fix as a hypothesis: re-derive it from the defect, apply it at the narrowest scope, and keep what each finding's `keep` names. Get the tests green.",
		`Then make one commit and push it to the PR branch (${run.branch}). Do not open a new PR and do not run a review.`,
		FIX_CONTRACT
	];
}

// What every fix phase hands back, so the run keeps a record of what changed
// and what proves it.
const FIX_CONTRACT = [
	'For each finding (or each test failure), re-derive it from the code before changing anything. Prefer adding a test that fails before your change and passes after it.',
	'End your reply with one fenced ```json block, exactly this shape:',
	'{"fixes":[{"finding":"the finding\'s id (F1), or file:line of a test failure","change":"file:line you changed","evidence":"test name or command and its result"}]}'
].join('\n');

// The red output, and the blockers still open from the last review so a test fix
// does not quietly undo them.
function redTestsTask(run: WorkflowRun): string[] {
	const open = openFindings(run);
	return [
		'The tests or typecheck failed. Fix the cause. Output tail:',
		'```',
		run.verifyOutput!,
		'```',
		...(open.length ? ['Open review findings. Do not undo what they asked for:', asJson(open)] : [])
	];
}

function fixPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	if (run.followUp) return followUpPrompt(run, step);
	// verifyOutput is set only while verify is red, and cleared when it passes.
	const task = run.verifyOutput
		? redTestsTask(run)
		: ['Address these review findings in the working tree. Each has an id; name it in your fixes report:', asJson(openFindings(run))];
	const earlier = run.pastFindings?.length ? ['Earlier review rounds asked for these, and they were applied:', asJson(run.pastFindings)] : [];
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		...task,
		...earlier,
		'Treat a suggested fix as a hypothesis: re-derive it from the defect, apply it at the narrowest scope, and keep what each finding\'s `keep` names. Do not commit and do not run a review.',
		EDIT_TEST_NOTE,
		'If a finding asks you to undo something an earlier round demanded, do not apply it. List each one under "disagreements" in the same closing json block: {"fixes":[...],"disagreements":["finding vs earlier finding, verbatim"]}.',
		FIX_CONTRACT
	];
}

function arbiterPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		'Two review rounds disagree. Rule which invariant wins and why, then apply the ruling in the working tree. Do not commit.',
		EDIT_TEST_NOTE,
		run.disagreement ?? ''
	];
}

function closerPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [
		skillLine(step, issueRef(run)),
		PHASE_NOTE,
		`These blockers are still standing after ${run.round} review rounds:`,
		asJson(openFindings(run)),
		'Either produce the correct fix in the working tree (no commit), or rule them invalid.',
		EDIT_TEST_NOTE,
		'End with a fenced ```json block: {"dismissed": true or false, "reason": "why"}.'
	];
}

// Each acceptance item is checked against the final code before the PR opens, and
// the numbers an issue asks for are reported, so a PR never claims more than it shows.
const ACCEPTANCE_NOTE =
	'Before committing, check every requirement and acceptance item in the issue against the final diff. Put an "Acceptance" section in the PR body: one line per item, met or not met, with its evidence (file and line, command output, or the measured number). Include every number the issue asks to report, such as before and after timings or counts, measured on the final code. If any item is not met, do not commit and do not open the PR: list the unmet items and stop.';

const PR_ACCEPTANCE_CONTRACT =
	'Report every checklist item, met or not, so the workflow can check it: end your reply with a fenced ```json block: {"acceptance":[{"id":"A1","status":"met|unmet","evidence":"..."}]}. The PR step passes only when every item is met.';

// The checklist the PR phase must account for, and what the owner already
// accepted as unmet.
function prChecklist(run: WorkflowRun): string[] {
	if (!run.acceptance?.length) return [];
	const accepted = run.acceptanceOverride?.ids ?? [];
	return [
		checklistBlock(run, 'The Acceptance section of the PR body lists these items by id.'),
		accepted.length
			? `The owner accepted ${accepted.join(', ')} as not met: open the PR anyway and mark them not met in its Acceptance section.`
			: '',
		PR_ACCEPTANCE_CONTRACT
	];
}

function prPrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext): string[] {
	const reviewer = run.reviewer ? ` reviewer=${run.reviewer}` : '';
	return [
		skillLine(step, `${issueRef(run)} base-branch=${run.base ?? ''}${reviewer} loop=no`),
		PHASE_NOTE,
		issueBlock(ctx, run),
		ACCEPTANCE_NOTE,
		...prChecklist(run),
		'The work in this worktree is implemented, tested, and reviewed. Run the commit and PR step only: one commit, push, open the PR with the issue linked by a closing keyword, request the reviewers. Do not run any review loop.'
	];
}

function feedbackPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [skillLine(step, run.pr?.url ?? ''), PHASE_NOTE, 'Run a single pass, not --watch.'];
}

function prReviewPrompt(run: WorkflowRun, step: WorkflowStep): string[] {
	return [skillLine(step, `${run.pr?.url ?? run.pr?.number ?? ''} --verdict`), PHASE_NOTE];
}

const PROMPTS: Record<WorkflowStep['role'], (run: WorkflowRun, step: WorkflowStep, ctx: PromptContext) => string[]> = {
	implement: implementPrompt,
	verify: () => [],
	review: reviewPrompt,
	fix: fixPrompt,
	arbiter: arbiterPrompt,
	closer: closerPrompt,
	pr: prPrompt,
	feedback: feedbackPrompt,
	'pr-review': prReviewPrompt
};

// What a person told the run, and the last driver's intent note. Never handed
// to a review phase: its value is that nobody told it what to think.
function steering(run: WorkflowRun, step: WorkflowStep): string[] {
	if (step.role === 'review' || step.role === 'pr-review') return [];
	const out: string[] = [];
	if (run.answers.length) out.push('Answers from the person running this:', ...run.answers.map((a) => `- ${a.text}`));
	if (run.handoff) out.push(`Handoff note from the previous driver (written against tree ${run.handoff.tree.slice(0, 10)}):`, run.handoff.text);
	return out;
}

export function phasePrompt(run: WorkflowRun, step: WorkflowStep, ctx: PromptContext = {}): string {
	return [...PROMPTS[step.role](run, step, ctx), ...steering(run, step)].filter(Boolean).join('\n\n');
}

// ---- Gates computed from outside data ----

// Why a start names a PR from another repo than the project's origin, or null
// when they match (or the origin can't be read, e.g. a local remote). The PR is
// fetched from the project's own origin, so a mismatch would check out and
// review a different PR with the same number. Issues may live in a separate
// tracker repo, so they aren't checked.
export function repoMismatch(origin: string | null, pr: Pick<RunPr, 'repo'> | undefined): string | null {
	if (!origin || !pr || pr.repo.toLowerCase() === origin.toLowerCase()) return null;
	return `${pr.repo} is not this project's repo (${origin})`;
}

// Why a follow-up fix hasn't landed on the PR branch, or null when it has: the
// session committed on the run's branch, kept history, left nothing
// uncommitted, and pushed to that branch's own upstream.
export function followUpProblem(state: PushState, from: string, branch: string): string | null {
	if (state.branch !== branch) return `the worktree is on ${state.branch}, not ${branch}`;
	if (!state.clean) return 'changes were left uncommitted';
	if (state.head === from) return 'no new commit';
	if (!state.descends) return 'the branch history was rewritten';
	if (state.head !== state.upstream || state.upstreamRef !== `${state.remote}/${branch}`) return 'the new commit is not pushed to the PR branch';
	return null;
}

// The number a closing keyword must name, for a GitHub-sourced issue
// (`owner/repo#233`). null for other sources, which link by comment instead.
export function githubIssueNumber(issue: Pick<SessionIssue, 'source' | 'id'> | undefined): number | null {
	if (issue?.source !== 'github') return null;
	const n = Number(issue.id.split('#').pop());
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The repo's test-and-typecheck command from its package.json scripts, run with
// the package manager its lockfile names. null when there is nothing to run.
export function detectVerifyCommand(scripts: Record<string, string> | undefined, lockfiles: string[]): string | null {
	if (!scripts) return null;
	const pm = lockfiles.includes('pnpm-lock.yaml') ? 'pnpm' : lockfiles.includes('yarn.lock') ? 'yarn' : lockfiles.includes('bun.lockb') ? 'bun' : 'npm';
	const parts = ['check', 'typecheck'].filter((s) => scripts[s]).slice(0, 1).map((s) => `${pm} run ${s}`);
	if (scripts.test) parts.push(`${pm} test`);
	return parts.length ? parts.join(' && ') : null;
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// `git diff -U0` as file ranges (`src/a.ts:L10-14`), the scope a later review
// round is handed. A pure deletion is a single line where it happened.
export function deltaRanges(diff: string): string[] {
	const ranges = new Map<string, string[]>();
	let file: string | null = null;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(6);
		const range = file ? hunkRange(line) : null;
		if (range) ranges.set(file!, [...(ranges.get(file!) ?? []), range]);
	}
	return [...ranges].map(([f, r]) => `${f}:${r.join(',')}`);
}

// A hunk header's new-side lines as `L4-6` (or `L4`), or null for any other line.
function hunkRange(line: string): string | null {
	const hunk = HUNK.exec(line);
	if (!hunk) return null;
	const start = Number(hunk[1]);
	const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
	return count > 1 ? `L${start}-${start + count - 1}` : `L${start}`;
}

export interface PrReviewView {
	state: string;
	reviewDecision: string | null;
	reviews: { author: string; state: string; commit?: string }[];
	headRefOid: string;
	unresolvedThreads: number;
	// Reviewers asked but not yet answered. Undercounts bot reviewers, which
	// gh omits from reviewRequests (see workflow-exec.ts).
	pendingReviewers: number;
}

function latestPerAuthor(reviews: PrReviewView['reviews']): string[] {
	const latest = new Map<string, string>();
	for (const r of reviews) if (r.state !== 'COMMENTED') latest.set(r.author, r.state);
	return [...latest.values()];
}

// Whether the reviewer loop is over: the PR merged or closed, or settled with
// nothing left to answer.
//
// "Settled" is stricter than it was, because it used to call a PR done on one
// approval and then a blocking review would arrive. Three things had to change:
// an approval no longer settles a PR while a reviewer still owes one, a
// CHANGES_REQUESTED is never overridden by the PR-wide decision, and the
// decision is preferred over counting approvals because it is the only signal
// that knows how many are required.
export function feedbackTerminal(view: PrReviewView): boolean {
	if (view.state === 'MERGED' || view.state === 'CLOSED') return true;
	if (view.unresolvedThreads > 0) return false;
	// Someone was asked and has not answered. Whatever has come in so far is a
	// partial picture, which is exactly how a late blocker gets missed.
	if (view.pendingReviewers > 0) return false;
	const verdicts = latestPerAuthor(view.reviews);
	// A blocking verdict ends it whatever the PR-wide decision says. The two
	// disagree while GitHub recomputes, and this is the direction where being
	// wrong costs something.
	if (verdicts.includes('CHANGES_REQUESTED')) return false;
	// With review requirements configured, the decision knows whether enough of
	// the right people have approved; counting approvals does not. Fall back to
	// the tally only when there is no decision to read.
	if (view.reviewDecision) return view.reviewDecision === 'APPROVED';
	return verdicts.includes('APPROVED');
}

// Reviewers whose latest verdict blocks the PR.
//
// GitHub does not ask a reviewer to look again when the author pushes a fix, so
// after a round answers a blocker the PR sits blocked with nobody holding it.
// These are who to ask again. Dismissed and commented-only reviews are not
// blockers and are left alone.
export function blockingReviewers(view: PrReviewView): string[] {
	const latest = new Map<string, string>();
	for (const r of view.reviews) if (r.state !== 'COMMENTED') latest.set(r.author, r.state);
	return [...latest]
		.filter(([author, state]) => state === 'CHANGES_REQUESTED' && author)
		.map(([author]) => author);
}

// The reviewer activity a feedback round answers. A new review or a change in
// open threads is new activity; the round's own replies resolve threads, so the
// signature is taken again when a round ends.
export function feedbackSignature(view: PrReviewView): string {
	return `${view.reviews.length}:${view.unresolvedThreads}`;
}

export function feedbackDue(view: PrReviewView, last: string | undefined): boolean {
	const active = view.reviews.length > 0 || view.unresolvedThreads > 0;
	return active && feedbackSignature(view) !== last;
}

// The pr-review gate: my review is on the PR's current head.
export function reviewedAtHead(view: PrReviewView, me: string): boolean {
	return view.reviews.some((r) => r.author === me && r.commit === view.headRefOid);
}

// ---- The digest ----

function phaseStatus(run: WorkflowRun, step: WorkflowStep, visits: PhaseVisit[]): PhaseStatus {
	if (run.phase === step.id && !isFinished(run)) return 'active';
	const last = visits.at(-1);
	if (!last) return 'pending';
	if (last.result === 'pass' || last.result === 'skipped') return last.result;
	return last.result ? 'fail' : 'active';
}

function phaseDigest(run: WorkflowRun, step: WorkflowStep): RunPhaseDigest {
	const visits = visitsOf(run, step.id);
	return {
		id: step.id,
		label: step.label,
		role: step.role,
		status: phaseStatus(run, step, visits),
		visits: visits.length,
		cap: step.cap,
		next: step.next,
		onFail: step.onFail,
		sessions: visits.map((v) => ({
			sessionId: v.sessionId,
			visit: v.visit,
			result: v.result,
			detail: v.detail,
			startedAt: v.startedAt,
			endedAt: v.endedAt,
			humanTouched: v.humanTouched
		})),
		decisions: run.decisions.filter((d) => d.step === step.id)
	};
}

export function runDigest(run: WorkflowRun, baseUrl: string): RunDigest {
	const review = stepWithRole(run, 'review');
	return {
		id: run.id,
		url: `${baseUrl}/runs/${run.id}`,
		workflow: { id: run.workflowId, name: run.workflowName, category: run.category, ...(run.variantOf ? { variantOf: run.variantOf } : {}) },
		title: run.title,
		projectPath: run.projectPath,
		cwd: run.cwd,
		branch: run.branch,
		base: run.base,
		issue: run.issue,
		pr: run.pr,
		status: run.status,
		phase: run.phase,
		round: run.round,
		cap: review?.cap,
		loop: run.loop,
		blockers: blockerCount(run.findings),
		findings: run.findings,
		followUps: run.followUps ?? [],
		acceptance: run.acceptance ?? [],
		escalations: run.escalations,
		humanTouched: run.humanTouched,
		phases: run.steps.map((s) => phaseDigest(run, s)),
		block: run.block,
		handoff: run.handoff,
		error: run.error,
		followUp: !!run.followUp,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt
	};
}

// ---- Loading stored runs ----

// A stored run, made safe to drive: a run written by an older deck or carrying a
// step list from a workflow since removed still loads, with any missing
// collection filled in. One whose current phase no longer exists is blocked
// rather than crashing the runner.
export function normalizeRun(raw: WorkflowRun, now: number): WorkflowRun {
	const run: WorkflowRun = {
		...raw,
		steps: Array.isArray(raw.steps) ? raw.steps : [],
		visits: Array.isArray(raw.visits) ? raw.visits : [],
		findings: Array.isArray(raw.findings) ? raw.findings : [],
		decisions: Array.isArray(raw.decisions) ? raw.decisions : [],
		answers: Array.isArray(raw.answers) ? raw.answers : [],
		failures: raw.failures ?? {},
		escalations: Object.assign({ implementer: false, disagreement: false, cap: false }, raw.escalations),
		epoch: raw.epoch ?? 0,
		round: raw.round ?? 0
	};
	ensureFindingIds(run);
	if (!isFinished(run) && !currentStep(run)) blockRun(run, run.phase, `The workflow has no step "${run.phase}" any more.`, now);
	return run;
}
