require('dotenv').config();
const { Telegraf } = require('telegraf');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { downloadFile } = require('./utils');

const bot = new Telegraf(process.env.BOT_TOKEN);

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'API_KEY_MISSING');
const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

// Function to store knowledge
async function storeKnowledge(content, source, type) {
    const { error } = await supabase.from('knowledge').insert({
        content,
        source,
        file_type: type
    });
    if (error) console.error('Error storing knowledge:', error);
}

// Function to retrieve relevant knowledge (Full Text Search)
async function retrieveKnowledge(query) {
    if (!query) return '';

    // 1. Try Full Text Search
    const { data: searchData, error: searchError } = await supabase
        .from('knowledge')
        .select('content, source')
        .textSearch('content', query, {
            type: 'websearch', // Supports "quoted phrases" or -negation
            config: 'spanish'
        })
        .limit(3);

    if (searchError) {
        console.error('Error during text search:', searchError);
    }

    if (searchData && searchData.length > 0) {
        console.log(`Found ${searchData.length} relevant docs via text search.`);
        return searchData.map(doc => `[Relevant Source: ${doc.source}]\n${doc.content}`).join('\n\n');
    }

    // 2. Fallback: Retrieve recent documents if search fails
    console.log('No specific text matches found. Falling back to recent documents.');
    const { data: recentData, error: recentError } = await supabase
        .from('knowledge')
        .select('content, source')
        .order('created_at', { ascending: false })
        .limit(5);

    if (recentError) {
        console.error('Error fetching recent documents:', recentError);
        return '';
    }

    if (recentData && recentData.length > 0) {
        console.log(`Found ${recentData.length} recent docs as fallback context.`);
        return recentData.map(doc => `[Recent Source: ${doc.source}]\n${doc.content}`).join('\n\n');
    }

    return '';
}

// Helper function to send long messages (Telegram limit is 4096 chars)
async function sendLongMessage(ctx, text) {
    const MAX_LENGTH = 4096;
    for (let i = 0; i < text.length; i += MAX_LENGTH) {
        const chunk = text.substring(i, i + MAX_LENGTH);
        await ctx.reply(chunk);
    }
}

// Debug middleware
bot.use(async (ctx, next) => {
    console.log('Using middleware. Update type:', ctx.updateType);
    if (ctx.message) console.log('Message content:', JSON.stringify(ctx.message, null, 2));
    await next();
});

bot.start((ctx) => ctx.reply('Welcome! I am your new intelligent Telegram bot powered by Gemini (Vision & Files).'));
bot.help((ctx) => ctx.reply('Send me a message, image, or PDF and I will process it.'));
bot.on('sticker', (ctx) => ctx.reply('👍'));
bot.hears('hi', (ctx) => ctx.reply('Hey there'));

// Document Handler (PDF, Text)
bot.on('document', async (ctx) => {
    try {
        const doc = ctx.message.document;
        const fileId = doc.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);

        await ctx.reply('Downloading and analyzing document with Gemini...');

        const buffer = await downloadFile(fileLink.href);
        let text = '';

        if (doc.mime_type === 'application/pdf' || doc.mime_type.startsWith('text/')) {
            // Use Gemini to extract text/content
            const modelVision = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
            const prompt = "Extract all the text from this document verbatim. If it is a medical result, preserve the structure as much as possible.";

            const result = await modelVision.generateContent([
                prompt,
                {
                    inlineData: {
                        data: Buffer.from(buffer).toString('base64'),
                        mimeType: doc.mime_type
                    }
                }
            ]);
            const response = await result.response;
            text = response.text();

        } else {
            return ctx.reply('Sorry, I currently only support PDF and Text files.');
        }

        if (!text) {
            throw new Error("No text extracted from document.");
        }

        // Check for caption and prepend to text
        const caption = ctx.message.caption;
        let finalContent = text;
        if (caption) {
            finalContent = `[User Note: ${caption}]\n\n${text}`;
        }

        await storeKnowledge(finalContent, doc.file_name, doc.mime_type);
        await ctx.reply(`Imported ${doc.file_name} into my knowledge base. Processed content length: ${text.length} chars.`);

    } catch (e) {
        console.error(e);
        ctx.reply('Error processing document: ' + e.message);
    }
});

// Photo Handler
bot.on('photo', async (ctx) => {
    try {
        const photos = ctx.message.photo;
        const fileId = photos[photos.length - 1].file_id; // Get highest res
        const fileLink = await ctx.telegram.getFileLink(fileId);

        await ctx.reply('Analyzing image...');
        const buffer = await downloadFile(fileLink.href);

        // Use Gemini Vision
        const modelVision = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
        const result = await modelVision.generateContent([
            "Describe this image in detail and extract any visible text. Output raw text.",
            {
                inlineData: {
                    data: Buffer.from(buffer).toString('base64'),
                    mimeType: "image/jpeg"
                }
            }
        ]);
        const response = await result.response;
        const description = response.text();

        await storeKnowledge(description, 'Uploaded Image', 'image/jpeg');
        await ctx.reply('Image analyzed and stored in knowledge base: ' + description.substring(0, 100) + '...');

    } catch (e) {
        console.error(e);
        ctx.reply('Error processing image.');
    }
});

// Gemini Text Handler with Knowledge Retrieval + Memory
bot.on('text', async (ctx) => {
    try {
        const userId = ctx.message.from.id;
        const userText = ctx.message.text;

        // 1. Fetch History (Supabase)
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('chat_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);

        // 2. Retrieve Knowledge
        const knowledge = await retrieveKnowledge(userText);

        // 3. Construct Context
        let systemInstruction = "You are a developed AI assistant with access to a vast knowledge base, specialized in analyzing medical, pharmacological, and scientific documents. Your goal is to provide accurate summaries and answers based on the provided context. If the user asks about medical topics, provide information neutrally and scientifically based on the 'Retrieved Information'. Do not refuse to answer if the context contains the answer.";

        if (knowledge) {
            systemInstruction += `\n\nRetrieved Information from user Uploaded Documents:\n${knowledge}`;
        } else {
            console.log('No knowledge retrieved for this query.');
        }

        const history = (historyData || []).reverse().map(msg => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        const chat = model.startChat({
            history: history,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
                maxOutputTokens: 2000,
            },
            // CRITICAL: Force BLOCK_NONE for ALL categories
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
            ]
        });

        console.log('Sending message to Gemini...');
        const result = await chat.sendMessage(userText);
        const response = await result.response;

        console.log('Gemini Raw Response:', JSON.stringify(response, null, 2));

        const text = response.text();

        if (!text) {
            console.error('Gemini returned empty text. Candidates:', JSON.stringify(response.candidates, null, 2));
            await ctx.reply('Reviewing the medical data... (The AI formulated an empty response. Check server logs for details.)');
            return;
        }

        await sendLongMessage(ctx, text);

        // 4. Save new messages to Supabase
        await supabase.from('messages').insert({ chat_id: userId, role: 'user', content: userText });
        await supabase.from('messages').insert({ chat_id: userId, role: 'model', content: text });

    } catch (error) {
        console.error('Error generating AI response:', error);
        await ctx.reply('Sorry, I encountered an error. Please checking your API Key, Database or try again later.');
    }
});

bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

console.log('Bot is running...');
