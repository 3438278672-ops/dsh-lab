// Fixture cases for the patched Messages translate().
// Each case is a raw SSE event list (the shape the adapter receives from
// POST /v1/messages) plus a check over the emitted stream chunks.
//
// The contract under test:
//   - every stop_reason the Messages protocol documents is a terminal turn
//     state, never MALFORMED_RESPONSE;
//   - refusal keeps the turn alive: one readable text block + {kind:'stop'};
//   - genuinely broken streams still fail as MALFORMED_RESPONSE.

const START = { type: 'message_start', message: { usage: { input_tokens: 14631, output_tokens: 0 } } };

function textBlock(text) {
	return [
		{ type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
		{ type: 'content_block_stop', index: 0 },
	];
}

function thinkingBlock(text) {
	return [
		{ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: text } },
		{ type: 'content_block_stop', index: 0 },
	];
}

export const CASES = [
	{
		name: 'refusal-with-no-content-is-a-normal-stop',
		events: [START, { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 22 } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			const blocks = blocksOf(chunks);
			return error === undefined && finishOf(chunks)?.reason?.kind === 'stop' && blocks.length === 1 && blocks[0].type === 'text' && blocks[0].text.length > 0;
		},
	},
	{
		name: 'refusal-carries-stop-details-explanation',
		events: [START, { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null, stop_details: { type: 'refusal', explanation: 'safety-review' } }, usage: { output_tokens: 8 } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			const blocks = blocksOf(chunks);
			return error === undefined && blocks.length === 1 && blocks[0].text.includes('safety-review');
		},
	},
	{
		name: 'refusal-after-thinking-keeps-order',
		events: [START, ...thinkingBlock('pondering'), { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 22 } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			const blocks = blocksOf(chunks);
			return error === undefined && blocks.length === 2 && blocks[0].type === 'reasoning' && blocks[1].type === 'text' && finishOf(chunks)?.reason?.kind === 'stop';
		},
	},
	{
		name: 'pause-turn-is-terminal-not-malformed',
		events: [START, ...textBlock('partial answer'), { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			return error === undefined && finishOf(chunks)?.reason?.kind === 'stop';
		},
	},
	{
		name: 'context-window-exceeded-maps-to-max-tokens',
		events: [START, ...textBlock('truncated answer'), { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			return error === undefined && finishOf(chunks)?.reason?.kind === 'max-tokens';
		},
	},
	{
		name: 'cancelled-is-terminal-not-malformed',
		events: [START, ...textBlock('cancelled mid-stream'), { type: 'message_delta', delta: { stop_reason: 'cancelled' } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			return error === undefined && finishOf(chunks)?.reason?.kind === 'stop';
		},
	},
	{
		name: 'unknown-stop-reason-still-malformed',
		events: [START, { type: 'message_delta', delta: { stop_reason: 'banana' } }, { type: 'message_stop' }],
		check({ error }) {
			return error?.code === 'MALFORMED_RESPONSE';
		},
	},
	{
		name: 'plain-end-turn-unchanged',
		events: [START, ...textBlock('hello'), { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
		check({ error, chunks }) {
			return error === undefined && finishOf(chunks)?.reason?.kind === 'stop';
		},
	},
	{
		name: 'tool-use-still-tool-calls',
		events: [
			START,
			{ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: {} } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"tz":"UTC"}' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'tool_use' } },
			{ type: 'message_stop' },
		],
		check({ error, chunks }) {
			return error === undefined && finishOf(chunks)?.reason?.kind === 'tool-calls';
		},
	},
];

const finishOf = (chunks) => chunks.find((chunk) => chunk.type === 'finish');
const blocksOf = (chunks) => chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block);

async function collect(translate, events) {
	const chunks = [];
	try {
		for await (const chunk of translate(events, 'deepseek-flash')) chunks.push(chunk);
		return { chunks };
	} catch (error) {
		return { chunks, error };
	}
}

export async function run(translate) {
	const results = [];
	for (const testCase of CASES) {
		const result = await collect(translate, testCase.events);
		let pass = false;
		let detail = '';
		try {
			pass = testCase.check(result) === true;
		} catch (error) {
			detail = String(error?.stack ?? error);
		}
		if (!pass && !detail) {
			detail = result.error
				? `error: ${result.error.code} ${result.error.message}`
				: `chunks: ${JSON.stringify(result.chunks).slice(0, 500)}`;
		}
		results.push({ name: testCase.name, pass, detail });
	}
	const failed = results.filter((entry) => !entry.pass);
	return { total: results.length, passed: results.length - failed.length, failed, results };
}
