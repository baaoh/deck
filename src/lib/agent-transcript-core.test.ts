import { describe, it, expect } from 'vitest';
import { lastTurnErrors, projectTranscript } from './agent-transcript-core';

const assistant = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
// How every agent kind persists the prompt sent to it (claude.ts / runner.ts).
const user = (text: string) => ({ type: 'deck.user', text, ts: 0 });

describe('projectTranscript', () => {
	it('extracts user/assistant prose and the last assistant reply', () => {
		const out = projectTranscript([user('do the thing'), assistant('on it'), assistant('done: PR opened')]);
		expect(out.messages).toEqual([
			{ role: 'user', text: 'do the thing' },
			{ role: 'assistant', text: 'on it' },
			{ role: 'assistant', text: 'done: PR opened' }
		]);
		expect(out.lastResult).toBe('done: PR opened');
	});

	it('joins multi-block assistant text and trims', () => {
		const ev = { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b ' }] } };
		expect(projectTranscript([ev]).lastResult).toBe('ab');
	});

	it('drops tool calls, tool results, and deck markers', () => {
		const events = [
			{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', content: 'output' }] } },
			{ type: 'result', subtype: 'success' },
			{ type: 'deck.model', model: 'opus' },
			{ type: 'deck.unreadable' }
		];
		const out = projectTranscript(events);
		expect(out.messages).toEqual([]);
		expect(out.lastResult).toBeNull();
	});

	it('caps the message list to the tail', () => {
		const many = Array.from({ length: 60 }, (_, i) => assistant(`m${i}`));
		const out = projectTranscript(many);
		expect(out.messages).toHaveLength(40);
		expect(out.messages[0].text).toBe('m20');
		expect(out.lastResult).toBe('m59');
	});

	it('is empty for a transcript with no prose', () => {
		expect(projectTranscript([])).toEqual({ messages: [], lastResult: null });
	});
});

describe('lastTurnErrors', () => {
	it('reads an errored claude result and a flagged assistant message', () => {
		const events = [
			user('go'),
			{ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'Claude AI usage limit reached' }] } },
			{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1700000000' }
		];
		expect(lastTurnErrors(events)).toContain('rate_limit');
		expect(lastTurnErrors(events)).toContain('usage limit reached|1700000000');
	});

	it('reads codex errors from a failed turn', () => {
		const events = [user('go'), { type: 'deck.error', text: 'You exceeded your current quota' }, { type: 'result', subtype: 'error' }];
		expect(lastTurnErrors(events)).toBe('You exceeded your current quota');
	});

	it('ignores errors from an earlier turn and from a turn that ended clean', () => {
		expect(lastTurnErrors([user('a'), { type: 'deck.error', text: '429' }, { type: 'result', subtype: 'error' }, user('b'), assistant('ok')])).toBe('');
		expect(lastTurnErrors([user('a'), { type: 'deck.error', text: 'retrying after 429' }, assistant('done'), { type: 'result', subtype: 'success' }])).toBe('');
	});

	it('does not read the agent\'s own prose as an error', () => {
		expect(lastTurnErrors([user('a'), assistant('added a rate limit returning 429'), { type: 'result', subtype: 'error' }])).toBe('');
	});
});
