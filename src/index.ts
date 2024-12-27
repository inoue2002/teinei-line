import { Message, MessageAPIResponseBase, TemplateMessage, TextMessage, WebhookEvent } from '@line/bot-sdk';
import { Hono } from 'hono';

const app = new Hono();
app.get('*', (c) => c.text('Hello World!'));

const geminiApiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent';

const systemPrompt = {
	club: `あなたは与えられたテキストを、部活の先輩に送るメッセージとして適切な、丁寧な言葉遣いに変換するAIです。
    変換後のテキストは、元のテキストの意図を正確に伝えつつ、部活の先輩に対して失礼のないようにしてください。
    返答は変換後のテキストのみを返してください。`,
	circle: `あなたは与えられたテキストを、サークルのメンバーに送るメッセージとして適切な、少し丁寧でカジュアルな言葉遣いに変換するAIです。
    変換後のテキストは、元のテキストの意図を正確に伝えつつ、サークルのメンバーに対して失礼のないようにしてください。
    返答は変換後のテキストのみを返してください。`,
	jobHunting: `あなたは与えられたテキストを、就職活動の場面で使うような最も硬く丁寧な言葉遣いに変換するAIです。
    変換後のテキストは、元のテキストの意図を正確に伝えつつ、採用担当者に対して失礼のないようにしてください。
    返答は変換後のテキストのみを返してください。`,
	adult: `あなたは与えられたテキストを、目上の大人に送るメッセージとして適切な、丁寧な言葉遣いに変換するAIです。
    変換後のテキストは、元のテキストの意図を正確に伝えつつ、目上の大人に対して失礼のないようにしてください。
    返答は変換後のテキストのみを返してください。`,
};

type ConversionType = 'club' | 'circle' | 'jobHunting' | 'adult';

const createConversionButtons = (originalText: string): TemplateMessage => ({
	type: 'template',
	altText: '変換シーンを選択してください',
	template: {
		type: 'buttons',
		text: 'このメッセージをどのように丁寧にしますか？',
		actions: [
			{ type: 'postback', label: '部活', data: `club_${originalText}` },
			{ type: 'postback', label: 'サークル', data: `circle_${originalText}` },
			{ type: 'postback', label: '就職活動', data: `jobHunting_${originalText}` },
			{ type: 'postback', label: '目上の大人', data: `adult_${originalText}` },
		],
	},
});

const sendReply = async (replyToken: string, messages: Message[], accessToken: string): Promise<void> => {
	await fetch('https://api.line.me/v2/bot/message/reply', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${accessToken}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ replyToken, messages }),
	});
};

const handleTextMessage = async (event: WebhookEvent, accessToken: string): Promise<MessageAPIResponseBase | undefined> => {
	// @ts-ignore
	const { replyToken } = event;
	const originalText = event.message.text.replace(/[\n\s]+/g, ' ').trim();
	const response = createConversionButtons(originalText);
	await sendReply(replyToken, [response], accessToken);
	return;
};

const handlePostbackChange = async (event: WebhookEvent, accessToken: string): Promise<MessageAPIResponseBase | undefined> => {
	const originalText = event.postback.data.replace('change_', '');
	const response = createConversionButtons(originalText);
	await sendReply(event.replyToken, [response], accessToken);
	return;
};

const handlePostbackNextMessage = async (event: WebhookEvent, accessToken: string): Promise<MessageAPIResponseBase | undefined> => {
	const response: TextMessage = { type: 'text', text: '次のメッセージを入力してください。' };
	await sendReply(event.replyToken, [response], accessToken);
	return;
};

const startLoading = async (chatId: string, accessToken: string) => {
	await fetch('https://api.line.me/v2/bot/chat/loading/start', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${accessToken}`,
		},
		body: JSON.stringify({ chatId, loadingSeconds: 10 }),
	});
};

const fetchGeminiResponse = async (prompt: string, conversionType: ConversionType, geminiApiKey: string) => {
	const geminiRequest = {
		contents: [
			{ role: 'user', parts: [{ text: systemPrompt[conversionType] }] },
			{ role: 'user', parts: [{ text: prompt }] },
		],
	};

	const geminiResponse = await fetch(geminiApiUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-goog-api-key': geminiApiKey,
		},
		body: JSON.stringify(geminiRequest),
	});

	if (!geminiResponse.ok) {
		const errorText = await geminiResponse.text();
		throw new Error(`Gemini API request failed: ${geminiResponse.status} ${errorText}`);
	}

	return (await geminiResponse.json()) as { candidates: { content: { parts: { text: string }[] }[] }[] };
};

const createPoliteTextResponse = (politeText: string, originalText: string): TemplateMessage => ({
	type: 'template',
	altText: '変換されたテキストです',
	template: {
		type: 'buttons',
		text: politeText,
		actions: [
			{ type: 'clipboard', label: 'コピー', clipboardText: politeText },
			{ type: 'postback', label: '他のシーンで変換', data: `change_${originalText}` },
			{ type: 'postback', label: '次のメッセージ', data: 'next_message', inputOption: 'openKeyboard' },
		],
	},
});

const handleQuickReplyResponse = async (
	event: WebhookEvent,
	accessToken: string,
	geminiApiKey: string
): Promise<MessageAPIResponseBase | undefined> => {
	if (event.type !== 'postback') {
		console.log('event type is not postback');
		return;
	}

	const { replyToken, source } = event;
	const data = event.postback.data;
	const [conversionType, originalText] = data.split('_') as [ConversionType, string];

	if (!conversionType || !originalText) {
		console.error('Invalid postback data:', data);
		return;
	}

	await startLoading(source.userId, accessToken);

	const promptMap: { [key in ConversionType]: string } = {
		club: `以下のテキストを、部活の場面に適した丁寧な言葉遣いに変換してください。\n\n${originalText}`,
		circle: `以下のテキストを、サークルの場面に適した丁寧な言葉遣いに変換してください。\n\n${originalText}`,
		jobHunting: `以下のテキストを、就職活動の場面に適した丁寧な言葉遣いに変換してください。\n\n${originalText}`,
		adult: `以下のテキストを、目上の大人に適した丁寧な言葉遣いに変換してください。\n\n${originalText}`,
	};

	const prompt = promptMap[conversionType];
	console.log('Prompt:', prompt);

	try {
		const geminiData = await fetchGeminiResponse(prompt, conversionType, geminiApiKey);
		let politeText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;

		if (!politeText) {
			console.error('Gemini API response missing polite text:', geminiData);
			const errorResponse: TextMessage = {
				type: 'text',
				text: 'エラーが発生しました: Gemini APIからの応答にテキストが含まれていません。',
			};
			await sendReply(replyToken, [errorResponse], accessToken);
			return;
		}

		politeText = politeText.replace(/[\n\s]+$/g, '');
		const responses: Message[] = [
			{
				type: 'text',
				text: politeText,
			},
			createPoliteTextResponse(politeText, originalText),
		];
		await sendReply(replyToken, responses, accessToken);
	} catch (error: any) {
		console.error('Error during Gemini API call or response handling:', error);
		const errorResponse: TextMessage = {
			type: 'text',
			text: `エラーが発生しました: ${error.message}`,
		};
		await sendReply(replyToken, [errorResponse], accessToken);
	}
	return;
};

const handleEvent = async (event: WebhookEvent, accessToken: string, geminiApiKey: string): Promise<MessageAPIResponseBase | undefined> => {
	if (event.type === 'message' && event.message.type === 'text') {
		if (
			event.message.text === '部活' ||
			event.message.text === 'サークル' ||
			event.message.text === '就職活動' ||
			event.message.text === '目上の大人'
		) {
			await handleQuickReplyResponse(event, accessToken, geminiApiKey);
		} else {
			await handleTextMessage(event, accessToken);
		}
	} else if (event.type === 'postback') {
		if (event.postback.data.startsWith('change_')) {
			await handlePostbackChange(event, accessToken);
		} else if (event.postback.data === 'next_message') {
			await handlePostbackNextMessage(event, accessToken);
		} else {
			await handleQuickReplyResponse(event, accessToken, geminiApiKey);
		}
	}
	return;
};

app.post('/api/webhook', async (c) => {
	const data = await c.req.json();
	const events: WebhookEvent[] = (data as any).events;

	console.log(events);
	// @ts-ignore
	const accessToken: string = c.env.CHANNEL_ACCESS_TOKEN;
	// @ts-ignore
	const geminiApiKey: string = c.env.GEMINI_API_KEY;

	await Promise.all(
		events.map(async (event: WebhookEvent) => {
			try {
				await handleEvent(event, accessToken, geminiApiKey);
			} catch (err: unknown) {
				if (err instanceof Error) {
					console.error(err);
				}
				return c.json({
					status: 'error',
				});
			}
		})
	);
	return c.json({ message: 'ok' });
});

export default app;
