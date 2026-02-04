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
	pendingPath: string,
	proposedChanges?: number,
	autoApplied?: number,
): ChatCard {
	const sections: ChatCard["sections"] = [
		{
			header: "Summary",
			widgets: [{ textParagraph: { text: summary } }],
		},
	];

	// Add statistics section if we have counts
	if (proposedChanges !== undefined || autoApplied !== undefined) {
		const statsLines: string[] = [];
		if (autoApplied !== undefined && autoApplied > 0) {
			statsLines.push(`<b>${autoApplied}</b> low-risk fixes auto-applied`);
		}
		if (proposedChanges !== undefined && proposedChanges > 0) {
			statsLines.push(`<b>${proposedChanges}</b> changes staged for review`);
		}

		if (statsLines.length > 0) {
			sections.push({
				header: "Changes",
				widgets: [{ textParagraph: { text: statsLines.join("\n") } }],
			});
		}
	}

	// Add next steps
	sections.push({
		header: "Next Steps",
		widgets: [
			{
				textParagraph: {
					text: `Review pending changes at: <code>${pendingPath}</code>\n\nApprove or reject changes to update the memory.`,
				},
			},
		],
	});

	return {
		header: {
			title: "Agent Memory Reflection Complete",
			subtitle: `Daily reflection for ${date}`,
		},
		sections,
	};
}
