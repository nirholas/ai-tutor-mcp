#!/usr/bin/env node
// @three-ws/tutor-mcp — MCP server entry point.
//
// Gives any AI assistant the three.ws Pay-As-You-Learn tutor ledger over stdio:
//   • load_session  — read a session's itemized running tab (free, read-only)
//   • close_session — finalize the session + return its attested invoice (free)
//
// A thin wrapper over the three.ws tutor session API. Sessions are addressed by
// an opaque sessionId — no key, no signer. Answering questions is the paid
// action (handled elsewhere); viewing the tab and closing the session are free,
// so a learner is never charged to see what they owe or to end the session.
//
// Run standalone:
//   node packages/tutor-mcp/src/index.js
//
// Or wire into Claude Code / Cursor — see README.md.

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { def as loadSession } from './tools/load-session.js';
import { def as closeSession } from './tools/close-session.js';

// Single source of truth for the advertised server version — package.json.
const require = createRequire(import.meta.url);
const { version: PKG_VERSION } = require('../package.json');

export const TOOLS = [
	loadSession,
	closeSession,
];

/**
 * Construct a fully-registered McpServer without connecting a transport.
 * Registration is env-free, so this is safe to import from tests.
 * @returns {McpServer}
 */
export function buildServer() {
	const server = new McpServer(
		{ name: 'tutor-mcp', title: 'three.ws Tutor', version: PKG_VERSION },
		{
			capabilities: { tools: {} },
			instructions:
				'three.ws Tutor MCP — manage the ledger for a Pay-As-You-Learn tutoring session. ' +
				'load_session reads a session\'s itemized running tab by sessionId: one line item per ' +
				'answered question (text, level, output tokens, per-item cost in USDC atomics + a "$x.xxxxxx" ' +
				'string, timestamp), the status (open/closed), questionCount, and the running total. ' +
				'close_session finalizes the session and returns its attested invoice — it seals the ledger ' +
				'with a SHA-256 attestation, after which no further questions can be billed to it. Answering ' +
				'questions is the paid action and happens elsewhere; both tools here are FREE — viewing the ' +
				'tab and closing the session never charge the learner, and closing moves no funds. All data ' +
				'comes live from the three.ws tutor API — no API key or signer required.',
		},
	);

	for (const tool of TOOLS) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: tool.annotations,
			},
			async (args, extra) => {
				try {
					const result = await tool.handler(args, extra);
					const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
					return { content: [{ type: 'text', text }] };
				} catch (err) {
					const payload = {
						ok: false,
						error: err?.code || 'unhandled',
						message: err?.message || String(err),
						...(err?.status ? { status: err.status } : {}),
					};
					return {
						content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
						isError: true,
					};
				}
			},
		);
	}

	return server;
}

async function main() {
	const server = buildServer();
	const transport = new StdioServerTransport();
	await server.connect(transport);
	console.error(`[tutor-mcp@${PKG_VERSION}] connected over stdio with ${TOOLS.length} tools`);
}

// Connect stdio ONLY when this file is the process entry point. Importing the
// module (tests, embedding) must not grab the transport. realpath both sides:
// npm bin shims are symlinks, so argv[1] may differ from import.meta.url.
function isProcessEntryPoint() {
	if (!process.argv[1]) return false;
	try {
		return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
	} catch {
		return false;
	}
}

if (isProcessEntryPoint()) {
	main().catch((err) => {
		console.error('[tutor-mcp] fatal:', err);
		process.exit(1);
	});
}
