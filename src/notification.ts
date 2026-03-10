/**
 * Google Chat Notification
 *
 * Sends notifications to Google Chat via a webhook middleware.
 * Used to notify when scheduled reflections complete.
 *
 * Configure via environment variables:
 * - CHAT_WEBHOOK_URL: URL of your chat middleware endpoint
 * - CHAT_WEBHOOK_AUTH_KEY: Auth key for the middleware
 * - CHAT_WEBHOOK_SPACE_ID: Google Chat space ID to post to
 */

export interface ChatCard {
	header?: {
		title: string;
		subtitle?: string;
		imageUrl?: string;
	};
	sections: Array<{
		header?: string;
		collapsible?: boolean;
		uncollapsibleWidgetsCount?: number;
		widgets: Array<{
			textParagraph?: { text: string };
			buttons?: Array<{
				textButton: {
					text: string;
					onClick: { openLink: { url: string } };
				};
			}>;
		}>;
	}>;
}

/** Describes a single change applied during reflection */
export interface ReflectionChange {
	path: string;
	action: string;
	reason: string;
}

export interface NotificationOptions {
	/** Google Chat space ID (required - set via CHAT_WEBHOOK_SPACE_ID env var) */
	spaceId: string;
	/** URL of chat webhook middleware (required - set via CHAT_WEBHOOK_URL env var) */
	webhookUrl: string;
	/** Optional card for rich formatting */
	card?: ChatCard;
}

/**
 * Send a notification to Google Chat
 *
 * @param authKey - Chat webhook middleware auth key
 * @param message - Simple text message
 * @param options - Space ID, webhook URL, and optional card formatting
 */
export async function sendChatNotification(
	authKey: string,
	message: string,
	options: NotificationOptions,
): Promise<{ success: boolean; error?: string }> {
	const { spaceId, webhookUrl } = options;

	if (!webhookUrl) {
		return { success: false, error: "No webhookUrl provided - set CHAT_WEBHOOK_URL env var" };
	}
	if (!spaceId) {
		return { success: false, error: "No spaceId provided - set CHAT_WEBHOOK_SPACE_ID env var" };
	}

	// Build card - use provided card or create simple one
	const card: ChatCard = options?.card ?? {
		header: { title: "Agent Memory Reflection" },
		sections: [
			{
				widgets: [{ textParagraph: { text: message } }],
			},
		],
	};

	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Chat-Middleware-Auth-Key": authKey,
			},
			body: JSON.stringify({
				spaceId,
				card,
			}),
		});

		if (!response.ok) {
			const errorText = await response.text();
			return {
				success: false,
				error: `Chat middleware returned ${response.status}: ${errorText}`,
			};
		}

		return { success: true };
	} catch (e) {
		return {
			success: false,
			error: `Failed to send notification: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/**
 * Build a reflection completion notification card
 */
export function buildReflectionCard(
	date: string,
	summary: string,
	options?: {
		quickFixes?: ReflectionChange[];
		edits?: ReflectionChange[];
		failedEdits?: string[];
	},
): ChatCard {
	const sections: ChatCard["sections"] = [
		{
			header: "Summary",
			widgets: [{ textParagraph: { text: summary } }],
		},
	];

	const quickFixes = options?.quickFixes ?? [];
	const edits = options?.edits ?? [];
	const failedEdits = options?.failedEdits ?? [];

	// Quick fixes section (Phase A auto-applied)
	if (quickFixes.length > 0) {
		const fixLines = quickFixes.map((f) => `- <b>${f.path}</b> (${f.action}): ${f.reason}`);
		sections.push({
			header: `Quick Fixes (${quickFixes.length})`,
			collapsible: quickFixes.length > 3,
			uncollapsibleWidgetsCount: 1,
			widgets: [
				{
					textParagraph: {
						text: fixLines.join("\n"),
					},
				},
			],
		});
	}

	// Edits section (Phase B proposed + auto-applied)
	if (edits.length > 0) {
		const editLines = edits.map((e) => `- <b>${e.path}</b> (${e.action}): ${e.reason}`);
		sections.push({
			header: `Edits Applied (${edits.length})`,
			collapsible: edits.length > 3,
			uncollapsibleWidgetsCount: 1,
			widgets: [
				{
					textParagraph: {
						text: editLines.join("\n"),
					},
				},
			],
		});
	}

	// Failed edits section
	if (failedEdits.length > 0) {
		sections.push({
			header: `Failed (${failedEdits.length})`,
			widgets: [
				{
					textParagraph: {
						text: failedEdits.map((f) => `- ${f}`).join("\n"),
					},
				},
			],
		});
	}

	// If nothing happened, say so
	if (quickFixes.length === 0 && edits.length === 0) {
		sections.push({
			widgets: [
				{
					textParagraph: {
						text: "No changes made — memory looks good.",
					},
				},
			],
		});
	}

	return {
		header: {
			title: "Memory Reflection",
			subtitle: date,
		},
		sections,
	};
}
