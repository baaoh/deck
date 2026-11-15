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

const blocker = (file = 'src/a.ts'): Finding => ({ file, line: 1, severity: 'blocker', defect: 'broken' });
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
		for (let i = 0; i < 4; i++) {
			step(run, review([blocker()]));
			step(run, ok);
			step(run, ok);
		}
		step(run, review([blocker()]));
		expect(run.round).toBe(5);
		expect(run.phase).toBe('closer');
		expect(run.escalations.cap).toBe(true);
		expect(run.visits.at(-1)?.agent?.model).toBe('claude-fable-5-1');
		step(run, ok); // closer fixed it -> verify
		step(run, ok); // -> final review round
		expect(run.phase).toBe('review');
		expect(step(run, review([blocker()]))).toEqual({ type: 'block' });
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
		step(run, review([blocker('src/second.ts')]));
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
		expect(long).toContain('0 list items');
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

describe('the fix contract', () => {
	const contract = '{"fixes":[{"finding":"file:line of the finding","change":"file:line you changed","evidence":"test name or command and its result"}]}';

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
