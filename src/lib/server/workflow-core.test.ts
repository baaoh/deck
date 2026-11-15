import { describe, expect, it } from 'vitest';
import {
	BUILTIN_WORKFLOWS,
	acceptDismissal,
	advance,
	agentFor,
	beginVisit,
	blockerCount,
	capDiff,
	deltaRanges,
	detectVerifyCommand,
	feedbackDue,
	feedbackSignature,
	blockingReviewers,
	feedbackTerminal,
	githubIssueNumber,
	repoMismatch,
	matchProfile,
	newRun,
	normalizeRun,
	openFindings,
	acceptanceBlock,
	acceptanceFromIssue,
	acceptanceGaps,
	acceptOverride,
	parseStructured,
	phasePrompt,
	pickWorkflow,
	resolveWorkflows,
	reviewedAtHead,
	runDigest,
	unchangedReviewReason,
	usageLimitHit,
	issueAskItems,
	issueSizeProblem,
	verifyInfraFailure,
	stepById,
	type GateResult,
	type PrReviewView
} from './workflow-core';
import type { Finding, WorkflowRun } from '$lib/workflows';

const NOW = 1_000;

function devRun(loop = true): WorkflowRun {
	const def = pickWorkflow(BUILTIN_WORKFLOWS, { category: 'dev' })!;
	const run = newRun({
		id: 'r_1',
		def,
		projectPath: '/path/to/project',
		cwd: '/path/to/project-worktrees/acme-1',
		branch: 'acme-1',
		base: 'main',
		title: '#1',
		issue: { source: 'github', id: 'acme/web#1', url: 'https://github.com/acme/web/issues/1' },
		profile: { loop },
		now: NOW
	});
	beginVisit(run, run.phase, NOW);
	return run;
}

// Feed one result to the current phase and, when the core says to enter a step,
// open its visit the way the runner does.
function step(run: WorkflowRun, result: GateResult) {
	const effect = advance(run, result, NOW);
	if (effect.type === 'enter') beginVisit(run, effect.step, NOW);
	return effect;
}

const blocker = (file = 'src/a.ts'): Finding => ({ file, line: 1, severity: 'blocker', defect: 'broken', scenario: 'null input returns 500' });
// A later round: every finding the last round left open checked as fixed, plus new ones.
const fixedThen = (run: WorkflowRun, findings: Finding[]): GateResult => ({
	pass: blockerCount(findings) === 0,
	structured: { findings, verifications: openFindings(run).map((f) => ({ id: f.id!, status: 'fixed' as const, evidence: 'a.test.ts' })) }
});
const review = (findings: Finding[]): GateResult => ({ pass: blockerCount(findings) === 0, structured: { findings } });
const ok: GateResult = { pass: true };
const red: GateResult = { pass: false, output: 'FAIL src/a.test.ts' };

// Walk the run to its first review.
function toReview(run: WorkflowRun): void {
	step(run, ok); // implement -> verify
	step(run, ok); // verify -> review
}

describe('workflow definitions', () => {
	it('validates its own built-ins under the user rules', () => {
		expect(resolveWorkflows({ workflows: BUILTIN_WORKFLOWS }).problems).toEqual([]);
	});

	it('ships one default per category', () => {
		const { workflows, problems } = resolveWorkflows({});
		expect(problems).toEqual([]);
		expect(pickWorkflow(workflows, { category: 'dev' })?.id).toBe('dev');
		expect(pickWorkflow(workflows, { category: 'review' })?.id).toBe('review');
	});

	it('lets a user workflow take the default and skips a malformed one', () => {
		const bugfix = {
			id: 'bugfix',
			name: 'Bugfix',
			category: 'dev',
			default: true,
			steps: [{ id: 'implement', label: 'Implement', role: 'implement', skill: 'dev-workflow', gate: 'turn', next: 'done' }]
		};
		const broken = { ...bugfix, id: 'broken', steps: [{ ...bugfix.steps[0], next: 'nowhere' }] };
		const { workflows, problems } = resolveWorkflows({ workflows: [bugfix, broken, { id: 'x' }] });
		expect(pickWorkflow(workflows, { category: 'dev' })?.id).toBe('bugfix');
		expect(workflows.filter((w) => w.category === 'dev' && w.default)).toHaveLength(1);
		expect(workflows.some((w) => w.id === 'broken')).toBe(false);
		expect(problems).toHaveLength(2);
		expect(problems[0]).toContain('implement -> nowhere');
	});

	it('keeps a default when a user workflow replaces a built-in without marking one', () => {
		const dev = { id: 'dev', name: 'Mine', category: 'dev', steps: [{ id: 'a', label: 'A', role: 'implement', skill: 'x', gate: 'turn', next: 'done' }] };
		expect(pickWorkflow(resolveWorkflows({ workflows: [dev] }).workflows, { category: 'dev' })?.name).toBe('Mine');
	});

	it('rejects duplicate step ids and a session step with no skill', () => {
		const step = { id: 'a', label: 'A', role: 'implement', skill: 'x', gate: 'turn', next: 'done' };
		const base = { id: 'w', name: 'W', category: 'dev' };
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [step, step] }] }).problems[0]).toContain('used twice');
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [{ ...step, skill: undefined }] }] }).problems[0]).toContain('names no skill');
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [{ ...step, id: 'done' }] }] }).problems[0]).toContain('reserved');
		const loose = { ...step, role: 'review' };
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [loose] }] }).problems[0]).toBe('w: review step a must use the no-blockers gate');
		const pr = { ...step, role: 'pr', gate: 'turn' };
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [pr] }] }).problems[0]).toBe('w: pr step a must use the pr-linked gate');
		const exit = { ...step, gate: 'exit-zero' };
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [exit] }] }).problems[0]).toBe('w: implement step a must use the turn gate');
		expect(resolveWorkflows({ workflows: [{ ...base, steps: [{ ...step, gate: 'guess' }] }] }).problems[0]).toMatch(/^w: steps 0 gate/);
	});

	it('picks by id when one is named', () => {
		expect(pickWorkflow(BUILTIN_WORKFLOWS, { id: 'review' })?.category).toBe('review');
		expect(pickWorkflow(BUILTIN_WORKFLOWS, { id: 'gone' })).toBeUndefined();
	});
});

describe('matchProfile', () => {
	const profiles = {
		acme: { githubOwners: ['Acme'], reviewer: 'acme-bot', loopDefault: true, baseBranch: 'develop' },
		linearco: { prefixes: ['ENG'], loopDefault: false },
		github: { reviewer: 'none', loopDefault: false }
	};

	it('maps a GitHub owner case-insensitively', () => {
		expect(matchProfile(profiles, { owner: 'acme' })).toEqual({ loop: true, reviewer: 'acme-bot', baseBranch: 'develop' });
	});

	it('falls back to the generic github profile', () => {
		expect(matchProfile(profiles, { owner: 'other' })).toEqual({ loop: false, reviewer: 'none', baseBranch: undefined });
	});

	it('maps a Linear id by prefix, and runs without a loop when nothing matches', () => {
		expect(matchProfile(profiles, { issue: { source: 'linear', id: 'ENG-4' } }).loop).toBe(false);
		expect(matchProfile({}, { owner: 'acme' })).toEqual({ loop: false, reviewer: undefined, baseBranch: undefined });
	});
});

describe('advance: the dev loop', () => {
	it('walks implement, verify, review, PR, and the reviewer loop to done', () => {
		const run = devRun();
		toReview(run);
		expect(run.phase).toBe('review');
		step(run, review([]));
		expect(run.phase).toBe('pr');
		step(run, ok);
		expect(run.phase).toBe('feedback');
		expect(run.status).toBe('waiting');
		expect(step(run, ok)).toEqual({ type: 'done' });
		expect(run.status).toBe('done');
	});

	it('skips the reviewer loop when the profile has it off', () => {
		const run = devRun(false);
		toReview(run);
		step(run, review([]));
		expect(step(run, ok)).toEqual({ type: 'done' });
	});

	it('sends a red verify to fix with its output, and blocks after three reds in a row', () => {
		const run = devRun();
		step(run, ok);
		step(run, red);
		expect(run.phase).toBe('fix');
		expect(phasePrompt(run, stepById(run, 'fix')!)).toContain('FAIL src/a.test.ts');
		expect(phasePrompt(run, stepById(run, 'fix')!)).not.toContain('Open review findings');
		step(run, ok); // fix -> verify
		step(run, red);
		step(run, ok);
		expect(step(run, red)).toEqual({ type: 'block' });
		expect(run.block?.question).toContain('stayed red');
	});

	it('loops review and fix, and resets the red count once verify passes', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		expect(run.phase).toBe('fix');
		step(run, ok);
		step(run, ok);
		expect(run.phase).toBe('review');
		expect(run.round).toBe(1);
		expect(run.failures['verify#red']).toBe(0);
	});

	it('escalates the implementer after a first round with two or more blockers', () => {
		const run = devRun();
		toReview(run);
		expect(agentFor(run, stepById(run, 'fix')!).model).toBe('sonnet');
		step(run, review([blocker('a'), blocker('b')]));
		expect(run.escalations.implementer).toBe(true);
		expect(run.visits.at(-1)?.agent?.model).toBeUndefined();
		expect(run.decisions.at(-1)).toMatchObject({ by: 'engine', action: 'escalate', step: 'review' });
	});

	it('does not escalate on a single round-one blocker', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		expect(run.escalations.implementer).toBe(false);
	});

	it('runs round 1 at the session model and later rounds at sonnet', () => {
		const run = devRun();
		toReview(run);
		expect(run.visits.at(-1)?.agent).toEqual({ kind: 'claude' });
		step(run, review([blocker()]));
		step(run, ok);
		step(run, ok);
		expect(run.visits.at(-1)?.agent?.model).toBe('sonnet');
	});

	it('prefers a per-run override over every tier', () => {
		const run = devRun();
		run.stepAgents = { review: { kind: 'codex', model: 'gpt-x' } };
		expect(agentFor(run, stepById(run, 'review')!)).toEqual({ kind: 'codex', model: 'gpt-x' });
	});

	it('gives standing blockers one top-tier closer at the cap, then blocks', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		step(run, ok);
		step(run, ok);
		for (let i = 0; i < 3; i++) {
			step(run, fixedThen(run, [blocker()]));
			step(run, ok);
			step(run, ok);
		}
		step(run, fixedThen(run, [blocker()]));
		expect(run.round).toBe(5);
		expect(run.phase).toBe('closer');
		expect(run.escalations.cap).toBe(true);
		expect(run.visits.at(-1)?.agent?.model).toBe('claude-fable-5-1');
		step(run, ok); // closer fixed it -> verify
		step(run, ok); // -> final review round
		expect(run.phase).toBe('review');
		expect(step(run, fixedThen(run, [blocker()]))).toEqual({ type: 'block' });
		expect(run.block?.question).toContain('6 review rounds');
	});

	it('stops for a person when the closer rules the blockers invalid, and goes past review once accepted', () => {
		const run = devRun();
		run.escalations.cap = false;
		run.round = 4;
		toReview(run);
		step(run, review([blocker()]));
		expect(run.phase).toBe('closer');
		expect(step(run, { pass: true, structured: { dismissed: true, reason: 'the finding misreads the contract' } })).toEqual({ type: 'block' });
		expect(run.block).toMatchObject({ step: 'closer', kind: 'closer-dismissed', question: expect.stringContaining('the finding misreads the contract') });
		expect(run.findings).toHaveLength(1);
		expect(run.decisions.at(-1)).toMatchObject({ action: 'dismiss-proposed', reason: 'the finding misreads the contract' });
		expect(acceptDismissal(run, NOW)).toEqual({ type: 'enter', step: 'pr' });
		expect(run.findings).toEqual([]);
		expect(run.decisions.at(-1)).toMatchObject({ action: 'dismiss' });
	});

	it('carries on as before when the closer does not dismiss', () => {
		const run = devRun();
		run.round = 4;
		toReview(run);
		step(run, review([blocker()]));
		expect(step(run, { pass: true, structured: { dismissed: false, reason: 'fixed it' } })).toEqual({ type: 'enter', step: 'verify' });
	});

	it('sends a disagreement to the arbiter once, and blocks on a second', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		step(run, { pass: true, structured: { disagreements: ['round 2 undoes round 1'] } });
		expect(run.phase).toBe('arbiter');
		expect(phasePrompt(run, stepById(run, 'arbiter')!)).toContain('round 2 undoes round 1');
		step(run, ok);
		step(run, ok);
		step(run, review([blocker()]));
		expect(step(run, { pass: true, structured: { disagreements: ['again'] } })).toEqual({ type: 'block' });
	});

	it('retries a mechanical failure once, then blocks', () => {
		const run = devRun();
		expect(step(run, { pass: false, error: 'the session errored' })).toEqual({ type: 'enter', step: 'implement' });
		expect(run.visits.filter((v) => v.step === 'implement')).toHaveLength(2);
		expect(run.visits[0].result).toBe('error');
		expect(step(run, { pass: false, error: 'the session errored' })).toEqual({ type: 'block' });
		expect(run.block?.question).toContain('Implement failed');
	});

	it('blocks the reviewer loop at its round cap', () => {
		const run = devRun();
		toReview(run);
		step(run, review([]));
		step(run, ok);
		const cap = stepById(run, 'feedback')!.cap!;
		for (let i = 1; i < cap; i++) {
			expect(step(run, { pass: false })).toEqual({ type: 'wait' });
			beginVisit(run, 'feedback', NOW);
		}
		expect(step(run, { pass: false })).toEqual({ type: 'block' });
	});
});

describe('phase prompts', () => {
	it('has the PR phase check each acceptance item before it opens the PR', () => {
		const run = devRun();
		const prompt = phasePrompt(run, stepById(run, 'pr')!);
		expect(prompt).toContain('"Acceptance" section');
		expect(prompt).toContain('do not open the PR');
	});

	it('leaves the test suite to the verify step (#408)', () => {
		const run = devRun();
		expect(phasePrompt(run, stepById(run, 'implement')!)).toContain('run the repo\'s fast test command once');
		toReview(run);
		expect(phasePrompt(run, stepById(run, 'review')!)).toContain('Run no tests');
		step(run, review([blocker()]));
		expect(phasePrompt(run, stepById(run, 'fix')!)).toContain('the single test file you changed');
	});

	it('never hands a review phase the answers or the handoff note', () => {
		const run = devRun();
		toReview(run);
		run.answers.push({ text: 'the null case is intended', at: NOW });
		run.handoff = { text: 'I moved the guard', tree: 'abc123', at: NOW };
		const prompt = phasePrompt(run, stepById(run, 'review')!);
		expect(prompt).not.toContain('the null case is intended');
		expect(prompt).not.toContain('I moved the guard');
		expect(prompt).toContain('You did not write this code');
		expect(prompt).toContain('"findings"');
		expect(phasePrompt(run, stepById(run, 'fix')!)).toContain('the null case is intended');
	});

	it('scopes round 1 to the whole diff and later rounds to the delta plus what was skipped', () => {
		const run = devRun();
		const reviewStep = stepById(run, 'review')!;
		expect(phasePrompt(run, reviewStep, { delta: ['src/a.ts:L1'] })).toContain('whole branch diff against main');
		run.round = 1;
		run.coverage = { examined: [], notExamined: ['src/b.ts: generated'] };
		const later = phasePrompt(run, reviewStep, { delta: ['src/a.ts:L4-9'] });
		expect(later).toContain('- src/a.ts:L4-9');
		expect(later).toContain('- src/b.ts: generated');
	});

	it('hands the fixer this round\'s blockers and what earlier rounds asked for', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker('src/first.ts')]));
		step(run, ok);
		step(run, ok);
		step(run, fixedThen(run, [blocker('src/second.ts')]));
		const prompt = phasePrompt(run, stepById(run, 'fix')!);
		expect(prompt).toContain('src/second.ts');
		expect(prompt).toContain('Earlier review rounds asked for these');
		expect(prompt).toContain('src/first.ts');
	});

	it('invokes the skill named by the step', () => {
		const run = devRun();
		expect(phasePrompt(run, stepById(run, 'implement')!).startsWith('/dev-workflow https://github.com/acme/web/issues/1')).toBe(true);
	});
});

describe('usageLimitHit', () => {
	it('recognises claude and codex usage and rate limits', () => {
		for (const text of [
			'Claude AI usage limit reached|1700000000',
			"You've hit your session limit · resets 3pm",
			'5-hour limit reached ∙ resets 2am',
			'rate_limit',
			'API Error: 429 {"type":"error"}',
			'You exceeded your current quota, please check your plan',
			'stream error: Rate limit exceeded'
		]) {
			expect(usageLimitHit(text), text).toBe(true);
		}
	});

	it('leaves other failures to the normal retry', () => {
		for (const text of ['Disk quota exceeded', 'ENOSPC: no space left on device', 'request limit reached for this file']) expect(usageLimitHit(text), text).toBe(false);
		expect(usageLimitHit('')).toBe(false);
		expect(usageLimitHit('codex turn failed: sandbox denied')).toBe(false);
		expect(usageLimitHit('API Error: 500 overloaded')).toBe(false);
	});
});

describe('verifyInfraFailure', () => {
	it('names kills, memory, and timeouts', () => {
		expect(verifyInfraFailure(137, 'whatever')).toBe('killed (exit 137)');
		expect(verifyInfraFailure(1, 'sh: line 1:  4242 Killed   node test.js')).toBe('killed (exit 1)');
		expect(verifyInfraFailure(134, 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory')).toBe('out of memory');
		expect(verifyInfraFailure(1, 'Error: spawn ENOMEM')).toBe('out of memory');
		expect(verifyInfraFailure(124, '')).toBe('the test slot timed out (exit 124)');
		expect(verifyInfraFailure(143, 'partial output', true)).toBe('the verify command timed out');
	});

	it('leaves real failures and passes alone', () => {
		expect(verifyInfraFailure(0, 'Killed')).toBeNull();
		expect(verifyInfraFailure(1, 'FAIL src/a.test.ts > kills the worker')).toBeNull();
		expect(verifyInfraFailure(2, 'error TS2322: Type is not assignable')).toBeNull();
	});
});

describe('issue size', () => {
	const list = (n: number, bullet = '-') => Array.from({ length: n }, (_, i) => `${bullet} item ${i}`).join('\n');

	it('counts list items under requirement-like headings at any level or as a bold line', () => {
		expect(issueAskItems(`## Requirements\n${list(3)}\n\n## Notes\n${list(5)}`)).toBe(3);
		expect(issueAskItems(`#### acceptance criteria\n${list(2, '1.')}\n- [ ] checkbox`)).toBe(3);
		expect(issueAskItems(`**Ask:**\n${list(2, '*')}\n__Scope__\n${list(2, '+')}`)).toBe(4);
		expect(issueAskItems(`### What to do\n${list(2)}\n  - nested`)).toBe(3);
		expect(issueAskItems(`## Out of scope\n${list(4)}\n## Background\n${list(4)}`)).toBe(0);
	});

	it('flags more than ten items, or a body over 12,000 characters', () => {
		expect(issueSizeProblem({ issueBody: `## Requirements\n${list(10)}` })).toBeNull();
		const many = issueSizeProblem({ issueBody: `## Requirements\n${list(11)}` });
		expect(many).toContain('11 list items');
		expect(many).toContain('Split this issue, or resume to run it anyway.');
		const long = issueSizeProblem({ issueBody: 'x'.repeat(12_001) });
		expect(long).not.toContain('list items');
		expect(long).toContain('12001 characters');
	});

	it('never stops a run without issue text', () => {
		expect(issueSizeProblem(undefined)).toBeNull();
		expect(issueSizeProblem({ warnings: ['gh failed'] })).toBeNull();
	});
});

describe('capDiff', () => {
	const file = (name: string, size: number) => `diff --git a/${name} b/${name}\n${'+'.repeat(size)}\n`;

	it('keeps a diff under the cap whole', () => {
		const diff = file('a.ts', 10) + file('b.ts', 10);
		expect(capDiff(diff, 1000)).toEqual({ text: diff, omitted: [], truncated: false });
	});

	it('cuts at a file boundary and lists the files left out by name', () => {
		const diff = file('a.ts', 40) + file('b.ts', 40) + file('c.ts', 5);
		const out = capDiff(diff, 100);
		expect(out.text).toBe(file('a.ts', 40));
		expect(out.omitted).toEqual(['b.ts', 'c.ts']);
		expect(out.truncated).toBe(true);
	});

	it('cuts a first file that is too big on its own', () => {
		const out = capDiff(file('big.ts', 500) + file('b.ts', 5), 100);
		expect(out.text).toHaveLength(100);
		expect(out.omitted).toEqual(['b.ts']);
		expect(out.truncated).toBe(true);
	});

	it('says so in the review prompt when the diff was cut', () => {
		const run = devRun();
		toReview(run);
		const prompt = phasePrompt(run, stepById(run, 'review')!, { diff: capDiff(file('a.ts', 40) + file('b.ts', 40), 100) });
		expect(prompt).toContain('```diff\ndiff --git a/a.ts b/a.ts');
		expect(prompt).toContain('cut at about 60,000 characters');
		expect(prompt).toContain('- b.ts');
		expect(prompt).toContain('Scope: the whole branch diff against main');
	});

	it('fences a diff that holds backticks with a longer fence', () => {
		const run = devRun();
		toReview(run);
		const prompt = phasePrompt(run, stepById(run, 'review')!, { diff: capDiff('diff --git a/x.md b/x.md\n+```js\n') });
		expect(prompt).toContain('````diff\n');
	});
});

describe('unchangedReviewReason', () => {
	it('stops a review of a tree that matches the base', () => {
		const run = devRun();
		expect(unchangedReviewReason(run, 't0', 't0')).toContain('Implement produced no changes');
		expect(unchangedReviewReason(run, 't1', 't0')).toBeNull();
		expect(unchangedReviewReason(run, 't1', null)).toBeNull();
	});

	it('stops a review after a fix that left the reviewed tree as it was', () => {
		const run = devRun();
		run.reviewTree = 't1';
		for (const s of ['review', 'fix', 'verify', 'review']) beginVisit(run, s, NOW);
		expect(unchangedReviewReason(run, 't1', 't0')).toContain('The fix changed nothing');
		expect(unchangedReviewReason(run, 't2', 't0')).toBeNull();
	});

	it('lets a review resumed after its own block look again', () => {
		const run = devRun();
		run.reviewTree = 't1';
		for (const s of ['review', 'fix', 'verify', 'review', 'review']) beginVisit(run, s, NOW);
		expect(unchangedReviewReason(run, 't1', 't0')).toBeNull();
	});
});

describe('advance: a block result', () => {
	it('blocks the run on the step without a retry', () => {
		const run = devRun();
		const effect = advance(run, { pass: false, block: { question: 'stop here', kind: 'issue-size' } }, NOW);
		expect(effect).toEqual({ type: 'block' });
		expect(run.block).toMatchObject({ step: 'implement', question: 'stop here', kind: 'issue-size' });
		expect(run.visits[0]).toMatchObject({ result: 'fail', detail: 'stop here' });
	});
});

describe('finding ids across rounds', () => {
	const verdict = (id: string, status: 'fixed' | 'not_fixed' | 'regressed') => ({ id, status, evidence: 'see a.test.ts' });
	const later = (findings: Finding[], verifications: ReturnType<typeof verdict>[]): GateResult => ({ pass: false, structured: { findings, verifications } });

	// Round 1 with the given blockers, then fix and verify back to review.
	function round1(run: WorkflowRun, findings: Finding[]): void {
		toReview(run);
		step(run, review(findings));
		step(run, ok);
		step(run, ok);
	}

	it('gives each finding a run-scoped id and hands round 2 the open ones to verify', () => {
		const run = devRun();
		round1(run, [blocker('src/a.ts'), { file: 'src/b.ts', severity: 'nit', defect: 'naming' }]);
		expect(run.findings.map((f) => f.id)).toEqual(['F1', 'F2']);
		const prompt = phasePrompt(run, stepById(run, 'review')!);
		expect(prompt).toContain('The last round left these findings open');
		expect(prompt).toContain('"id": "F1"');
		expect(prompt).not.toContain('"id": "F2"');
		expect(prompt).toContain('"verifications":[{"id":"F1","status":"fixed|not_fixed|regressed"');
		expect(prompt).toContain('concrete failing "scenario"');
		expect(phasePrompt(devRun(), stepById(run, 'review')!)).not.toContain('"verifications"');
	});

	it('counts the open findings still not fixed plus the new blockers that count', () => {
		const run = devRun();
		round1(run, [blocker('src/a.ts'), blocker('src/b.ts'), blocker('src/c.ts')]);
		step(run, later([blocker('src/d.ts')], [verdict('F1', 'fixed'), verdict('F2', 'regressed')]));
		expect(run.findings.map((f) => [f.id, f.severity])).toEqual([
			['F2', 'blocker'],
			['F3', 'blocker'],
			['F4', 'blocker']
		]);
		// F3 had no verdict: still open, never dropped by omission.
		expect(run.findings[1].verification).toEqual({ status: 'not_fixed', evidence: 'not checked by the review' });
		expect(run.findings[0].verification?.status).toBe('regressed');
		expect(run.pastFindings?.map((f) => f.id)).toEqual(['F1']);
		expect(run.visits.filter((v) => v.step === 'review').at(-1)).toMatchObject({ result: 'fail', detail: '3 blockers, 3 findings' });
		const fix = phasePrompt(run, stepById(run, 'fix')!);
		expect(fix).toContain('"id": "F2"');
		expect(fix).toContain('name it in your fixes report');
	});

	it('passes once every open finding is verified fixed', () => {
		const run = devRun();
		round1(run, [blocker()]);
		step(run, later([], [verdict('F1', 'fixed')]));
		expect(run.phase).toBe('pr');
	});

	it('turns a later-round blocker without a scenario, or outside the delta, into a follow-up nit', () => {
		const run = devRun();
		round1(run, [blocker()]);
		run.visits.at(-1)!.delta = ['src/a.ts:L10-20'];
		run.coverage = { examined: [], notExamined: ['src/skipped.ts: too long'] };
		const noScenario = { ...blocker('src/a.ts'), line: 12, scenario: undefined };
		const outside = { ...blocker('src/far.ts'), line: 3 };
		const inRange = { ...blocker('src/a.ts'), line: 15 };
		const caller = { ...blocker('src/caller.ts'), line: 40, via: 'src/a.ts:11' };
		const skipped = { ...blocker('src/skipped.ts'), line: 99 };
		step(run, later([noScenario, outside, inRange, caller, skipped], [verdict('F1', 'fixed')]));
		expect(run.findings.map((f) => [f.id, f.severity])).toEqual([
			['F2', 'nit'],
			['F3', 'nit'],
			['F4', 'blocker'],
			['F5', 'blocker'],
			['F6', 'blocker']
		]);
		expect(run.followUps?.map((f) => f.id)).toEqual(['F2', 'F3']);
		expect(run.decisions.at(-1)).toMatchObject({ action: 'downgrade', reason: expect.stringContaining('F2 (no failing scenario), F3 (outside the changed ranges') });
		expect(runDigest(run, 'http://x').followUps.map((f) => f.id)).toEqual(['F2', 'F3']);
	});

	it('never downgrades a round-1 blocker', () => {
		const run = devRun();
		toReview(run);
		step(run, review([{ ...blocker(), scenario: undefined }]));
		expect(run.findings[0].severity).toBe('blocker');
		expect(run.followUps).toBeUndefined();
	});

	it('escalates the fix after two rounds not fixed, and blocks naming the finding after the escalated fix', () => {
		const run = devRun();
		round1(run, [blocker()]);
		expect(run.escalations.implementer).toBe(false);
		step(run, later([], [verdict('F1', 'not_fixed')]));
		expect(run.escalations.implementer).toBe(false);
		step(run, ok);
		step(run, ok);
		step(run, later([], [verdict('F1', 'not_fixed')]));
		expect(run.escalations.implementer).toBe(true);
		expect(run.decisions.at(-1)).toMatchObject({ action: 'escalate', reason: expect.stringContaining('F1 not fixed in two rounds running') });
		expect(run.phase).toBe('fix');
		expect(run.visits.at(-1)?.agent).toEqual(stepById(run, 'fix')!.escalateAgent);
		step(run, ok);
		step(run, ok);
		expect(step(run, later([], [verdict('F1', 'not_fixed')]))).toEqual({ type: 'block' });
		expect(run.block?.question).toContain('F1 (src/a.ts:1): broken');
	});

	it('starts the count over once a finding is fixed', () => {
		const run = devRun();
		round1(run, [blocker('src/a.ts'), blocker('src/b.ts')]);
		run.escalations.implementer = false;
		step(run, later([], [verdict('F1', 'not_fixed'), verdict('F2', 'fixed')]));
		expect(run.openStreak).toEqual({ F1: 1 });
	});

	it('reads verification statuses loosely and drops a malformed one alone', () => {
		const parsed = parseStructured('```json\n{"findings":[],"verifications":[{"id":"F1","status":"Not fixed","evidence":"x"},{"id":"F2","status":"maybe"},{"status":"fixed"}]}\n```');
		expect(parsed?.verifications).toEqual([{ id: 'F1', status: 'not_fixed', evidence: 'x' }]);
		expect(parsed?.findings).toEqual([]);
	});

	it('gives the findings of a run stored before ids their ids on load', () => {
		const run = devRun();
		run.findings = [blocker('src/a.ts'), { ...blocker('src/b.ts'), id: 'F4' }];
		const loaded = normalizeRun(JSON.parse(JSON.stringify(run)), NOW);
		expect(loaded.findings.map((f) => f.id)).toEqual(['F5', 'F4']);
		expect(loaded.findingSeq).toBe(5);
	});
});

describe('the acceptance checklist', () => {
	const body = ['## Context', '- not an ask', '## Acceptance criteria', '- [ ] exports CSV', '- [x] keeps the header', '1. reports the row count', '## Out of scope', '- PDF'].join('\n');

	function withChecklist(): WorkflowRun {
		const run = devRun();
		run.acceptance = acceptanceFromIssue({ issueBody: body });
		return run;
	}

	it('reads the acceptance items from the issue, numbered', () => {
		expect(acceptanceFromIssue({ issueBody: body })).toEqual([
			{ id: 'A1', text: 'exports CSV' },
			{ id: 'A2', text: 'keeps the header' },
			{ id: 'A3', text: 'reports the row count' }
		]);
		expect(acceptanceFromIssue({ issueBody: 'just prose' })).toEqual([]);
		expect(acceptanceFromIssue(undefined)).toEqual([]);
	});

	it('shows implement the checklist, or asks it to write one and stores that', () => {
		const run = withChecklist();
		const prompt = phasePrompt(run, stepById(run, 'implement')!);
		expect(prompt).toContain('- A1: exports CSV');
		expect(prompt).not.toContain('Write one from the issue');

		const bare = devRun();
		expect(phasePrompt(bare, stepById(bare, 'implement')!)).toContain('{"acceptance":[{"id":"A1","text":"..."}]}');
		const reply = parseStructured('```json\n{"acceptance":[{"id":"x","text":"exports CSV"},{"id":"y","text":" "},{"id":"z","text":"counts rows"}]}\n```')!;
		step(bare, { pass: true, structured: reply });
		expect(bare.acceptance).toEqual([
			{ id: 'A1', text: 'exports CSV' },
			{ id: 'A2', text: 'counts rows' }
		]);
	});

	it('never replaces a checklist the issue gave', () => {
		const run = withChecklist();
		step(run, { pass: true, structured: { acceptance: [{ id: 'A1', text: 'something else' }] } });
		expect(run.acceptance?.[0].text).toBe('exports CSV');
	});

	it('has review report each item, and makes an unmet one a blocker under its id', () => {
		const run = withChecklist();
		toReview(run);
		const prompt = phasePrompt(run, stepById(run, 'review')!);
		expect(prompt).toContain('- A2: keeps the header');
		expect(prompt).toContain('"acceptance":[{"id":"A1","status":"met|unmet|not_verifiable"');
		const reply = parseStructured('```json\n{"findings":[],"acceptance":[{"id":"a1","status":"met"},{"id":"A2","status":"not met","evidence":"header dropped"},{"id":"A3","status":"not_verifiable"}]}\n```')!;
		step(run, { pass: false, structured: reply });
		expect(run.phase).toBe('fix');
		expect(run.findings).toEqual([
			{ id: 'A2', file: 'acceptance', severity: 'blocker', defect: 'Acceptance item A2 is not met: keeps the header', fix: 'header dropped' }
		]);
		expect(run.acceptance?.map((a) => a.status)).toEqual(['met', 'unmet', 'not_verifiable']);
		expect(phasePrompt(run, stepById(run, 'fix')!)).toContain('"id": "A2"');

		// Round 2 does not ask to verify A2 by id: the checklist is reported again.
		step(run, ok);
		step(run, ok);
		expect(phasePrompt(run, stepById(run, 'review')!)).not.toContain('The last round left these findings open');
		step(run, { pass: false, structured: { findings: [], acceptance: [{ id: 'A2', status: 'unmet' }] } });
		expect(run.openStreak).toEqual({ A2: 1 });
		step(run, ok);
		step(run, ok);
		step(run, { pass: true, structured: { findings: [], acceptance: [{ id: 'A2', status: 'met' }] } });
		expect(run.phase).toBe('pr');
	});

	it('has the PR phase report every item by id', () => {
		const run = withChecklist();
		const prompt = phasePrompt(run, stepById(run, 'pr')!);
		expect(prompt).toContain('- A3: reports the row count');
		expect(prompt).toContain('{"acceptance":[{"id":"A1","status":"met|unmet","evidence":"..."}]}');
		expect(prompt).not.toContain('The owner accepted');
		run.acceptanceOverride = { at: NOW, by: 'human', ids: ['A3'] };
		expect(phasePrompt(run, stepById(run, 'pr')!)).toContain('The owner accepted A3 as not met');
	});

	it('gates the PR on every item reported met, unless the owner accepted the gaps', () => {
		const run = withChecklist();
		const met = (id: string) => ({ id, status: 'met' as const });
		expect(acceptanceGaps(run, [met('A1'), met('A2'), met('A3')])).toEqual([]);
		const gaps = acceptanceGaps(run, [met('A1'), { id: 'A2', status: 'unmet' }]);
		expect(gaps.map((g) => [g.id, g.status])).toEqual([
			['A2', 'unmet'],
			['A3', undefined]
		]);
		const question = acceptanceBlock(gaps, 'https://github.com/acme/web/pull/9');
		expect(question).toContain('- A2 (unmet): keeps the header');
		expect(question).toContain('- A3 (no status reported)');
		expect(question).toContain('A PR was opened anyway: https://github.com/acme/web/pull/9');
		expect(acceptanceBlock(gaps, null)).toContain('No PR was opened.');
		expect(acceptanceGaps(devRun(), [])).toEqual([]);
		run.acceptanceOverride = { at: NOW, by: 'human', ids: ['A2', 'A3'] };
		expect(acceptanceGaps(run, [])).toEqual([]);
	});

	it('records the override and goes on past the PR step', () => {
		const run = withChecklist();
		toReview(run);
		step(run, review([]));
		run.acceptanceOverride = { at: NOW, by: 'human', ids: ['A2'] };
		expect(acceptOverride(run, NOW)).toEqual({ type: 'enter', step: 'feedback' });
		expect(run.decisions.at(-1)).toMatchObject({ step: 'pr', action: 'accept-unmet', reason: expect.stringContaining('A2') });
		expect(runDigest(run, 'http://x').acceptance).toHaveLength(3);
	});
});

describe('the fix contract', () => {
	const contract = '{"fixes":[{"finding":"the finding\'s id (F1), or file:line of a test failure","change":"file:line you changed","evidence":"test name or command and its result"}]}';

	it('ends every fix prompt with the fixes block, for findings and for red tests', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker('src/x.ts')]));
		const findingsPrompt = phasePrompt(run, stepById(run, 'fix')!);
		expect(findingsPrompt.endsWith(contract)).toBe(true);
		expect(findingsPrompt).toContain('Prefer adding a test that fails before your change');
		run.verifyOutput = 'FAIL src/a.test.ts';
		expect(phasePrompt(run, stepById(run, 'fix')!).endsWith(contract)).toBe(true);
	});

	it('hands a red-tests fix the open blockers so it does not undo them', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker('src/keep.ts')])); // -> fix
		step(run, ok); // -> verify
		step(run, red); // -> fix with the test output
		const prompt = phasePrompt(run, stepById(run, 'fix')!);
		expect(prompt).toContain('FAIL src/a.test.ts');
		expect(prompt).toContain('Open review findings. Do not undo what they asked for:');
		expect(prompt.indexOf('src/keep.ts')).toBeGreaterThan(prompt.indexOf('Open review findings'));
	});

	it('stores the fix report, and keeps the disagreements beside it', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		const reply = '```json\n{"fixes":[{"finding":"src/a.ts:1","change":"src/a.ts:3","evidence":"a.test.ts passes"}]}\n```';
		step(run, { pass: true, structured: parseStructured(reply)! });
		expect(run.fixes).toEqual([{ finding: 'src/a.ts:1', change: 'src/a.ts:3', evidence: 'a.test.ts passes' }]);
		const both = parseStructured('```json\n{"fixes":"not a list","disagreements":["x vs y"]}\n```');
		expect(both).toMatchObject({ disagreements: ['x vs y'] });
		expect(both?.fixes).toBeUndefined();
	});

	it('is not a failure when the report is missing', () => {
		const run = devRun();
		toReview(run);
		step(run, review([blocker()]));
		step(run, ok);
		expect(run.phase).toBe('verify');
		expect(run.fixes).toBeUndefined();
	});
});

describe('parseStructured', () => {
	it('reads the last valid json block', () => {
		const text = [
			'example:',
			'```json\n{"findings":[{"file":"x","severity":"nit","defect":"old"}]}\n```',
			'not json:',
			'```json\n{nope}\n```',
			'```json\n{"findings":[{"file":"src/a.ts","line":3,"severity":"blocker","defect":"d","fix":"f","keep":"k"}],"coverage":{"examined":["src/a.ts"],"notExamined":[]}}\n```'
		].join('\n');
		const parsed = parseStructured(text);
		expect(parsed?.findings?.[0]).toMatchObject({ file: 'src/a.ts', severity: 'blocker' });
		expect(parsed?.coverage?.examined).toEqual(['src/a.ts']);
	});

	it('skips a trailing unrelated json block for the real verdict above it', () => {
		const text = '```json\n{"findings":[]}\n```\nconfig:\n```json\n{"port":3000}\n```';
		expect(parseStructured(text)).toEqual({ findings: [] });
	});

	it('returns null without a block', () => {
		expect(parseStructured(null)).toBeNull();
		expect(parseStructured('all good')).toBeNull();
	});

	it('normalises severity so the gate and the fix prompt agree', () => {
		const parsed = parseStructured('```json\n{"findings":[{"file":"src/a.ts","severity":"Blocker","defect":"d"}]}\n```');
		expect(parsed?.findings?.[0].severity).toBe('blocker');
		const run = devRun();
		toReview(run);
		step(run, { pass: false, structured: parsed! });
		expect(run.phase).toBe('fix');
		expect(phasePrompt(run, stepById(run, 'fix')!)).toContain('src/a.ts');
	});
});

describe('gates from outside data', () => {
	it('detects the verify command from scripts and the lockfile', () => {
		expect(detectVerifyCommand({ check: 'svelte-check', test: 'vitest' }, ['pnpm-lock.yaml'])).toBe('pnpm run check && pnpm test');
		expect(detectVerifyCommand({ typecheck: 'tsc', test: 'jest' }, [])).toBe('npm run typecheck && npm test');
		expect(detectVerifyCommand({ build: 'vite build' }, ['yarn.lock'])).toBeNull();
		expect(detectVerifyCommand(undefined, [])).toBeNull();
	});

	it('turns a zero-context diff into file ranges', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -3,0 +4,3 @@',
			'@@ -10 +13 @@',
			'diff --git a/src/gone.ts b/src/gone.ts',
			'--- a/src/gone.ts',
			'+++ /dev/null',
			'@@ -1,4 +0,0 @@'
		].join('\n');
		expect(deltaRanges(diff)).toEqual(['src/a.ts:L4-6,L13']);
	});

	it('refuses a PR from another repo than the project origin', () => {
		expect(repoMismatch('Acme/Web', { repo: 'acme/web' })).toBeNull();
		expect(repoMismatch('acme/web', { repo: 'other/app' })).toContain('other/app');
		expect(repoMismatch('acme/web', undefined)).toBeNull();
		expect(repoMismatch(null, { repo: 'other/app' })).toBeNull();
	});

	it('reads the issue number a closing keyword must name', () => {
		expect(githubIssueNumber({ source: 'github', id: 'acme/web#233' })).toBe(233);
		expect(githubIssueNumber({ source: 'linear', id: 'ENG-1' })).toBeNull();
		expect(githubIssueNumber(undefined)).toBeNull();
	});

	const view = (patch: Partial<PrReviewView>): PrReviewView => ({
		state: 'OPEN',
		reviewDecision: null,
		reviews: [],
		headRefOid: 'h2',
		unresolvedThreads: 0,
		pendingReviewers: 0,
		...patch
	});

	it('ends the reviewer loop on an approval with nothing open, or a merge', () => {
		expect(feedbackTerminal(view({ reviewDecision: 'APPROVED' }))).toBe(true);
		expect(feedbackTerminal(view({ reviewDecision: 'APPROVED', unresolvedThreads: 1 }))).toBe(false);
		expect(feedbackTerminal(view({ reviews: [{ author: 'bot', state: 'APPROVED' }] }))).toBe(true);
		expect(feedbackTerminal(view({ reviews: [{ author: 'bot', state: 'APPROVED' }, { author: 'ann', state: 'CHANGES_REQUESTED' }] }))).toBe(false);
		expect(feedbackTerminal(view({ state: 'MERGED' }))).toBe(true);
	});

	// The loop used to end on the first approval, so a blocking review that
	// landed after it was never answered.
	it('waits for a reviewer who was asked and has not answered', () => {
		const oneIn = { reviews: [{ author: 'bot', state: 'APPROVED' }] };
		expect(feedbackTerminal(view({ ...oneIn, pendingReviewers: 1 }))).toBe(false);
		expect(feedbackTerminal(view({ ...oneIn, pendingReviewers: 0 }))).toBe(true);
		// Even a PR-wide APPROVED does not settle it while someone still owes one.
		expect(feedbackTerminal(view({ reviewDecision: 'APPROVED', pendingReviewers: 1 }))).toBe(false);
	});

	it('never lets the PR-wide decision override a blocking review', () => {
		const blocked = { reviews: [{ author: 'ann', state: 'CHANGES_REQUESTED' }] };
		expect(feedbackTerminal(view({ ...blocked, reviewDecision: 'APPROVED' }))).toBe(false);
		expect(feedbackTerminal(view({ ...blocked, reviewDecision: null }))).toBe(false);
	});

	it('trusts the decision over counting approvals when the repo has requirements', () => {
		const approvals = { reviews: [{ author: 'bot', state: 'APPROVED' }] };
		// One approval, but GitHub still wants more: not settled.
		expect(feedbackTerminal(view({ ...approvals, reviewDecision: 'REVIEW_REQUIRED' }))).toBe(false);
		// No requirements configured, so the tally is all there is.
		expect(feedbackTerminal(view({ ...approvals, reviewDecision: null }))).toBe(true);
	});

	it('is not settled by comments alone', () => {
		expect(feedbackTerminal(view({ reviews: [{ author: 'ann', state: 'COMMENTED' }] }))).toBe(false);
	});

	it('names the reviewers whose latest verdict blocks, to ask them again', () => {
		// GitHub does not re-request on a push, so a round that answered a
		// blocker has to ask for the look itself.
		const blocked = view({
			reviews: [
				{ author: 'ann', state: 'CHANGES_REQUESTED' },
				{ author: 'bot', state: 'APPROVED' },
				{ author: 'cal', state: 'COMMENTED' }
			]
		});
		expect(blockingReviewers(blocked)).toEqual(['ann']);
	});

	it('takes only each reviewer\'s latest verdict', () => {
		const resolved = view({
			reviews: [
				{ author: 'ann', state: 'CHANGES_REQUESTED' },
				{ author: 'ann', state: 'APPROVED' }
			]
		});
		expect(blockingReviewers(resolved)).toEqual([]);
		// A comment after a block does not clear it.
		const stillBlocked = view({
			reviews: [
				{ author: 'ann', state: 'CHANGES_REQUESTED' },
				{ author: 'ann', state: 'COMMENTED' }
			]
		});
		expect(blockingReviewers(stillBlocked)).toEqual(['ann']);
	});

	it('asks nobody when nothing blocks', () => {
		expect(blockingReviewers(view({}))).toEqual([]);
		expect(blockingReviewers(view({ reviews: [{ author: 'bot', state: 'APPROVED' }] }))).toEqual([]);
	});

	it('starts a feedback round only on new reviewer activity', () => {
		expect(feedbackDue(view({}), undefined)).toBe(false);
		const active = view({ reviews: [{ author: 'bot', state: 'COMMENTED' }], unresolvedThreads: 2 });
		expect(feedbackDue(active, undefined)).toBe(true);
		expect(feedbackDue(active, feedbackSignature(active))).toBe(false);
	});

	it('passes a PR review only when my review is on the head', () => {
		expect(reviewedAtHead(view({ reviews: [{ author: 'me', state: 'APPROVED', commit: 'h1' }] }), 'me')).toBe(false);
		expect(reviewedAtHead(view({ reviews: [{ author: 'me', state: 'APPROVED', commit: 'h2' }] }), 'me')).toBe(true);
	});
});

describe('runDigest', () => {
	it('projects each phase with its visits, sessions, and decisions', () => {
		const run = devRun();
		run.visits[0].sessionId = 's_1';
		toReview(run);
		step(run, review([blocker()]));
		const d = runDigest(run, 'http://localhost:4818');
		expect(d.url).toBe('http://localhost:4818/runs/r_1');
		const byId = Object.fromEntries(d.phases.map((p) => [p.id, p]));
		expect(byId.implement).toMatchObject({ status: 'pass', visits: 1 });
		expect(byId.implement.sessions[0].sessionId).toBe('s_1');
		expect(byId.review).toMatchObject({ status: 'fail', visits: 1, cap: 5, onFail: 'fix' });
		expect(byId.fix.status).toBe('active');
		expect(byId.pr.status).toBe('pending');
		expect(d.blockers).toBe(1);
		expect(d).not.toHaveProperty('epoch');
	});
});

describe('normalizeRun', () => {
	it('loads a run whose workflow lost its current step without crashing', () => {
		const run = devRun();
		const stale = { ...run, phase: 'renamed', decisions: undefined, answers: undefined } as unknown as WorkflowRun;
		const loaded = normalizeRun(stale, NOW);
		expect(loaded.status).toBe('blocked');
		expect(loaded.block?.question).toContain('renamed');
		expect(loaded.answers).toEqual([]);
	});

	it('leaves a finished run alone', () => {
		const done = { ...devRun(), status: 'done', phase: 'gone' } as WorkflowRun;
		expect(normalizeRun(done, NOW).status).toBe('done');
	});
});

describe('canFixFindings', () => {
	const pr = { repo: 'acme/web', number: 5 };
	const nit = { file: 'a.ts', severity: 'nit', defect: 'd' };
	it('allows a done dev run with an open PR and leftover findings only', async () => {
		const { canFixFindings } = await import('$lib/workflows');
		expect(canFixFindings({ status: 'done', category: 'dev', pr, findings: [nit] })).toBe(true);
		expect(canFixFindings({ status: 'done', category: 'dev', pr, findings: [] })).toBe(false);
		expect(canFixFindings({ status: 'done', category: 'dev', findings: [nit] })).toBe(false);
		expect(canFixFindings({ status: 'done', category: 'review', pr, findings: [nit] })).toBe(false);
		expect(canFixFindings({ status: 'running', category: 'dev', pr, findings: [nit] })).toBe(false);
	});
});

describe('followUpProblem', () => {
	const ok = { head: 'c1', branch: 'feat', upstream: 'c1', upstreamRef: 'origin/feat', remote: 'origin', clean: true, descends: true };
	it('passes only a clean, pushed, descending commit on the run branch', async () => {
		const { followUpProblem } = await import('./workflow-core');
		expect(followUpProblem(ok, 'c0', 'feat')).toBeNull();
		expect(followUpProblem({ ...ok, branch: 'main' }, 'c0', 'feat')).toContain('not feat');
		expect(followUpProblem({ ...ok, clean: false }, 'c0', 'feat')).toContain('uncommitted');
		expect(followUpProblem(ok, 'c1', 'feat')).toBe('no new commit');
		expect(followUpProblem({ ...ok, descends: false }, 'c0', 'feat')).toContain('rewritten');
		expect(followUpProblem({ ...ok, upstream: 'c0' }, 'c0', 'feat')).toContain('not pushed');
		expect(followUpProblem({ ...ok, upstreamRef: 'origin/main' }, 'c0', 'feat')).toContain('not pushed');
		expect(followUpProblem({ ...ok, upstreamRef: 'origin/other/feat' }, 'c0', 'feat')).toContain('not pushed');
	});
});
