// Pure projection of a session's raw transcript events into readable turn output
// for the agent API (issue #144): the recent user/assistant messages and the last
// assistant reply. Node-free and defensive — transcript lines are heterogeneous
// (assistant / user / result / deck.* markers, occasionally an unreadable
// placeholder), so every shape is guarded. The IO (reading the tail) lives in
// server/transcript.ts.

export interface TranscriptMessage {
	role: 'assistant' | 'user';
	text: string;
}

export interface ProjectedTranscript {
	messages: TranscriptMessage[];
	// The session's most recent assistant reply — what an orchestrator reads to see
	// what the session actually said. null when it hasn't produced any text yet.
	lastResult: string | null;
}

// Cap the projected message list so a long turn's tail stays a bounded payload.
const MAX_MESSAGES = 40;

// Concatenate the text of an assistant/user message's content, which is either a
// bare string or an array of typed blocks. Tool-call / tool-result blocks carry no
// prose and contribute nothing.
function textFromContent(content: unknown): string {
	if (typeof content === 'string') return content.trim();
	if (!Array.isArray(content)) return '';
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: unknown; text?: unknown };
		if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
	}
	return parts.join('').trim();
}

type RawEvent = { type?: unknown; text?: unknown; message?: { content?: unknown } };

// A message with trimmed prose, or null when empty (a tool-only turn, an empty
// prompt) so it drops out of the projection.
function message(role: 'assistant' | 'user', text: string): TranscriptMessage | null {
	const trimmed = text.trim();
	return trimmed ? { role, text: trimmed } : null;
}

// One readable message per event type. `assistant`/`user` hold Claude-shaped
// content blocks; `deck.user` (how every agent kind persists the prompt sent to
// it — claude.ts and the per-turn runner both append it) holds flat `text`. A
// plain `type:'user'` event is only ever a tool_result here, so its content
// yields no prose and drops out. Any other type (tool_use, result footer, other
// deck.* markers) has no builder and is skipped.
const BUILDERS = new Map<string, (ev: RawEvent) => TranscriptMessage | null>([
	['assistant', (ev) => message('assistant', textFromContent(ev.message?.content))],
	['deck.user', (ev) => message('user', typeof ev.text === 'string' ? ev.text : '')],
	['user', (ev) => message('user', textFromContent(ev.message?.content))]
]);

// One transcript event → a readable message, or null. Map.get keeps arbitrary
// event types (including a torn line parsed to null) from reaching a builder.
function messageFrom(event: unknown): TranscriptMessage | null {
	const ev = (event ?? {}) as RawEvent;
	const build = typeof ev.type === 'string' ? BUILDERS.get(ev.type) : undefined;
	return build ? build(ev) : null;
}

export function projectTranscript(events: unknown[]): ProjectedTranscript {
	const messages: TranscriptMessage[] = [];
	let lastResult: string | null = null;
	for (const event of events) {
		const msg = messageFrom(event);
		if (!msg) continue;
		messages.push(msg);
		if (msg.role === 'assistant') lastResult = msg.text;
	}
	return { messages: messages.slice(-MAX_MESSAGES), lastResult };
}

type TurnEvent = { type?: unknown; text?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; error?: unknown; message?: { content?: unknown } };

// The error text a session's last turn ended with: deck.error lines (how codex
// and the per-turn runners report a failure), an errored result footer's text
// (claude's `is_error` result), and an assistant message flagged as an API
// error. Empty when the turn ended with a clean result: an agent may log an
// error mid-turn (a retried 429) and still finish its work.
export function lastTurnErrors(events: unknown[]): string {
	const start = events.findLastIndex((e) => (e as TurnEvent)?.type === 'deck.user');
	const turn = events.slice(start + 1) as (TurnEvent | null)[];
	const end = turn.findLast((e) => e?.type === 'result');
	if (end && end.is_error !== true && (end.subtype ?? 'success') === 'success') return '';
	const parts: string[] = [];
	for (const e of turn) {
		if (e?.type === 'deck.error' && typeof e.text === 'string') parts.push(e.text);
		else if (e?.type === 'result' && typeof e.result === 'string') parts.push(e.result);
		else if (e?.type === 'assistant' && e.error) parts.push(String(e.error), textFromContent(e.message?.content));
	}
	return parts.filter(Boolean).join('\n');
}
