
// deno-lint-ignore-file
import { Telegraf } from "npm:telegraf@4.16.3";
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from "npm:@google/generative-ai";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { appendToSheet, getSheetValues } from "./sheets.ts";

// Environment variables
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") || "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_KEY") || "";

let bot: Telegraf;
let model: any;
let supabase: any;
let genAI: any;

try {
    console.log("Initializing globals...");
    bot = new Telegraf(BOT_TOKEN);
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
    console.log("Globals initialized successfully.");
} catch (e: any) {
    console.error("CRITICAL: Error initializing globals:", e.message);
}

// Helper function to download file from URL and return ArrayBuffer
async function downloadFile(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to download file: ${response.statusText}`);
    return await response.arrayBuffer();
}

// Function to store knowledge
async function storeKnowledge(userId: number, content: string, source: string, type: string) {
    const { error } = await supabase.from('knowledge').insert({
        user_id: userId,
        content,
        source,
        file_type: type
    });
    if (error) console.error('Error storing knowledge:', error);
}

// Function to retrieve relevant knowledge
async function retrieveKnowledge(userId: number, query: string) {
    if (!query) return '';

    // 1. Try Full Text Search
    const { data: searchData, error: searchError } = await supabase
        .from('knowledge')
        .select('content, source')
        .eq('user_id', userId) // ISOLATION
        .textSearch('content', query, {
            type: 'websearch',
            config: 'spanish'
        })
        .limit(3);

    if (searchError) {
        console.error('Error during text search:', searchError);
    }

    if (searchData && searchData.length > 0) {
        console.log(`Found ${searchData.length} relevant docs via text search.`);
        return searchData.map((doc: any) => `[Relevant Source: ${doc.source}]\n${doc.content}`).join('\n\n');
    }

    // 2. Fallback: Retrieve recent documents
    console.log('No specific text matches found. Falling back to recent documents.');
    const { data: recentData, error: recentError } = await supabase
        .from('knowledge')
        .select('content, source')
        .eq('user_id', userId) // ISOLATION
        .order('created_at', { ascending: false })
        .limit(5);

    if (recentError) {
        console.error('Error fetching recent documents:', recentError);
        return '';
    }

    if (recentData && recentData.length > 0) {
        console.log(`Found ${recentData.length} recent docs as fallback context.`);
        return recentData.map((doc: any) => `[Recent Source: ${doc.source}]\n${doc.content}`).join('\n\n');
    }

    return '';
}

// Helper to send long messages with smart splitting
async function sendLongMessage(ctx: any, text: string) {
    const MAX_LENGTH = 4000; // Safe margin below 4096

    let remainingText = text;

    while (remainingText.length > 0) {
        if (remainingText.length <= MAX_LENGTH) {
            await ctx.reply(remainingText);
            break;
        }

        // Find the best split point
        let splitIndex = remainingText.lastIndexOf('\n', MAX_LENGTH);
        if (splitIndex === -1) {
            splitIndex = remainingText.lastIndexOf(' ', MAX_LENGTH);
        }

        // If no good split point found (extremely long word/string), force split
        if (splitIndex === -1) {
            splitIndex = MAX_LENGTH;
        }

        const chunk = remainingText.substring(0, splitIndex);
        await ctx.reply(chunk);

        // Remove the sent chunk and leading whitespace from the rest
        remainingText = remainingText.substring(splitIndex).trimStart();
    }
}

// --- Handlers ---

// Security Middleware
const AUTHORIZED_USERS = [
    6149934349, // User A (Alfredo)
    // 123456789, // User B (Invite) - Can be added here
];

bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !AUTHORIZED_USERS.includes(userId)) {
        console.log(`Unauthorized access attempt from: ${userId}`);
        await ctx.reply(`⛔ Access Denied. Your ID is ${userId}. This bot is private.`);
        return;
    }
    return next();
});

bot.start((ctx) => ctx.reply('Welcome! I am your intelligent assistant developed by Gemini 3 Pro (Supabase Edge).'));
bot.help((ctx) => ctx.reply('Send me a message, image, or PDF.\n\nCommands:\n/meds - List your medications\n/addmed <name> <morning> <evening> - Add medication\n/delmed <id> - Delete a medication'));

// --- Medication Management ---

bot.command('meds', async (ctx) => {
    const userId = ctx.from.id;
    const { data: meds, error } = await supabase
        .from('medications')
        .select('*')
        .eq('user_id', userId)
        .eq('active', true);

    if (error) return ctx.reply('Error fetching medications.');
    if (!meds || meds.length === 0) return ctx.reply('No tienes medicamentos registrados.');

    const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

    let response = '💊 *Tus Medicamentos:*\n\n';
    meds.forEach(m => {
        response += `• *${m.name}* (ID: ${m.id})\n`;
        if (m.morning_time) response += `  ☀️ Mañana: ${m.morning_time.substring(0, 5)}\n`;
        if (m.evening_time) response += `  🌙 Noche: ${m.evening_time.substring(0, 5)}\n`;

        // Add Scheduling info
        if (m.days_of_week && m.days_of_week.length > 0) {
            const days = m.days_of_week.map((d: number) => dayNames[d]).join(', ');
            response += `  📅 Días: ${days}\n`;
        } else if (m.frequency_days) {
            response += `  🔄 Frecuencia: Cada ${m.frequency_days} días\n`;
        } else {
            response += `  ✨ Todos los días\n`;
        }
        response += '\n';
    });
    response += 'Usa `/delmed <id>` para eliminar uno.';
    await ctx.replyWithMarkdown(response);
});

bot.command('addmed', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) return ctx.reply('Uso: /addmed <nombre> <hora_mañana> [hora_noche]\nEjemplo: /addmed Aspirina 08:00 20:00');

    const name = args[0];
    const morning = args[1];
    const evening = args[2] || null;

    const { error } = await supabase
        .from('medications')
        .insert({
            user_id: ctx.from.id,
            name,
            morning_time: morning,
            evening_time: evening,
            start_date: new Date().toISOString().split('T')[0]
        });

    if (error) return ctx.reply('Error al guardar el medicamento. Verifica el formato de hora (HH:MM).');

    // Simple logging to Sheets
    const timestamp = new Date().toISOString();
    await appendToSheet(ctx.from.id, "Medications!A:E", [[timestamp, name, morning, evening, 'active']]);

    await ctx.reply(`✅ ${name} registrado correctamente y guardado en Sheets.`);
});

bot.command('delmed', async (ctx) => {
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length === 0) return ctx.reply('Uso: /delmed <id>');

    const id = args[0];

    // 1. Deactivate medication
    const { error: medError } = await supabase
        .from('medications')
        .update({ active: false })
        .eq('id', id)
        .eq('user_id', ctx.from.id);

    if (medError) return ctx.reply('Error al eliminar el medicamento.');

    // 2. Cancel pending reminders
    await supabase
        .from('medication_reminders')
        .update({ status: 'cancelled' })
        .eq('med_id', id)
        .in('status', ['pending', 'snoozed']);

    await ctx.reply('✅ Medicamento eliminado y avisos pendientes cancelados.');
});

// --- Callback Handlers (Medication Interaction) ---

bot.on('callback_query', async (ctx) => {
    try {
        const data = ctx.callbackQuery.data;
        const userId = ctx.from.id;

        if (data.startsWith('med_taken_')) {
            const reminderId = data.replace('med_taken_', '');

            // 1. Update DB (Essential)
            const { data: reminder, error } = await supabase
                .from('medication_reminders')
                .update({ status: 'taken' })
                .eq('id', reminderId)
                .eq('user_id', userId)
                .select('*, medications(name)')
                .single();

            if (error) {
                console.error("DB Update Error (Taken):", error);
                return ctx.answerCbQuery('Error al confirmar en base de datos.');
            }

            // 2. Immediate Feedback
            await ctx.answerCbQuery('¡Excelente!');
            await ctx.editMessageText(`✅ Confirmado: Has tomado *${reminder.medications.name}*.\n\nTodo registrado correctamente.`, { parse_mode: 'Markdown' });

            // 3. Log to Sheets (Slower, done last)
            try {
                const timestamp = new Date().toISOString();
                await appendToSheet(userId, "Medication History!A:C", [
                    [timestamp, reminder.medications.name, reminder.slot]
                ]);
            } catch (sheetErr) {
                console.error("Sheet Log Error (Taken Callback):", sheetErr);
                // We already confirmed to user, so we just log the background error
            }
        }

        else if (data.startsWith('med_snooze_')) {
            const reminderId = data.replace('med_snooze_', '');
            const nextCheck = new Date(Date.now() + 30 * 60000).toISOString();

            const { error } = await supabase
                .from('medication_reminders')
                .update({
                    status: 'snoozed',
                    next_check: nextCheck
                })
                .eq('id', reminderId)
                .eq('user_id', userId);

            if (error) {
                console.error("DB Update Error (Snooze):", error);
                return ctx.answerCbQuery('Error al posponer.');
            }

            await ctx.answerCbQuery('Pospuesto 30m.');
            await ctx.editMessageText('⏳ Entendido. Te volveré a avisar en 30 minutos.', { parse_mode: 'Markdown' });
        }
    } catch (e: any) {
        console.error("Callback Query Error:", e);
        await ctx.answerCbQuery('Error interno del bot.');
    }
});


// Serve the Webhook
Deno.serve(async (req) => {
    try {
        if (req.method !== 'POST') {
            const healthStatus = {
                status: 'running',
                env_checks: {
                    BOT_TOKEN: !!BOT_TOKEN,
                    GEMINI_API_KEY: !!GEMINI_API_KEY,
                    SUPABASE_URL: !!SUPABASE_URL,
                    SUPABASE_KEY: !!SUPABASE_KEY
                }
            };
            return new Response(JSON.stringify(healthStatus));
        }

        const body = await req.json();
        const updateId = body.update_id;

        if (updateId) {
            // Duplicate Detection
            const { data: existing, error: checkError } = await supabase
                .from('processed_updates')
                .select('update_id')
                .eq('update_id', updateId)
                .single();

            if (existing) {
                console.log(`Duplicate update ignored: ${updateId}`);
                return new Response('ok');
            }

            // Register the update ID
            const { error: insertError } = await supabase
                .from('processed_updates')
                .insert({ update_id: updateId });

            if (insertError) {
                console.error('Error logging update ID:', insertError);
                // Continue anyway if it's just a logging error, but log it
            }
        }

        console.log("Full Body received:", JSON.stringify(body));
        console.log("Processing update for User ID:", body.message?.from?.id || body.callback_query?.from?.id || "unknown");
        await bot.handleUpdate(body);
        console.log("bot.handleUpdate finished.");
        return new Response('ok');
    } catch (e: any) {
        console.error("Function Error:", e.message, e.stack);
        return new Response('Error: ' + e.message, { status: 500 });
    }
});

// --- Document Handler ---
bot.on('document', async (ctx) => {
    try {
        const doc = ctx.message.document;
        const fileId = doc.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);

        await ctx.reply('Downloading and analyzing document with Gemini...');

        const buffer = await downloadFile(fileLink.href);
        const base64Data = encodeBase64(new Uint8Array(buffer));

        if (doc.mime_type === 'application/pdf' || doc.mime_type?.startsWith('text/')) {
            const modelVision = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

            // Optimized: Combined Extraction and Structuring
            const combinedPrompt = `You are a medical data extractor. 
            1. Extract ALL the text from this document verbatim.
            2. Identify health data (Medical exams OR weight/measurements logs).
               - If it is a medical laboratory report, extract findings into: { category: "exam", parameter: string, value: string, unit: string, range: string, date: string }.
               - If it is a weight log or body measurement, extract findings into: { category: "log", type: string, value: string, unit: string, note: string, date: string }.
            
            Output your response in the following format:
            ---VERBATIM_TEXT_START---
            [Insert full text here]
            ---VERBATIM_TEXT_END---
            ---JSON_DATA_START---
            [Insert JSON array of objects here]
            ---JSON_DATA_END---`;

            const result = await modelVision.generateContent([
                combinedPrompt,
                { inlineData: { data: base64Data, mimeType: doc.mime_type || 'application/pdf' } }
            ]);

            const responseText = result.response.text();

            // Extract verbatim text
            const verbatimMatch = responseText.match(/---VERBATIM_TEXT_START---([\s\S]*?)---VERBATIM_TEXT_END---/);
            const text = verbatimMatch ? verbatimMatch[1].trim() : "";

            // Extract JSON data
            const jsonMatch = responseText.match(/---JSON_DATA_START---([\s\S]*?)---JSON_DATA_END---/);
            const jsonStr = jsonMatch ? jsonMatch[1].trim().replace(/```json|```/g, "") : "[]";

            if (!text) {
                // If extraction failed, try a dedicated fallback or throw
                console.log("Combined extraction failed to find markers, falling back to raw response parsing.");
            }

            try {
                const values = JSON.parse(jsonStr);
                if (Array.isArray(values) && values.length > 0) {
                    await ctx.reply(`Detected ${values.length} data points. Sending to Sheets...`);
                    const timestamp = new Date().toISOString();

                    const examRows: any[][] = [];
                    const logRows: any[][] = [];

                    values.forEach((v: any) => {
                        const caption = ctx.message.caption;
                        const entryDate = v.date || caption || timestamp;
                        if (v.category === "exam") {
                            examRows.push([entryDate, doc.file_name, v.parameter, v.value, v.unit, v.range]);
                        } else {
                            logRows.push([entryDate, "Document", v.type || "Weight", v.value]);
                        }
                    });

                    if (examRows.length > 0) await appendToSheet(ctx.from.id, "Medical Exams!A:G", examRows);
                    if (logRows.length > 0) await appendToSheet(ctx.from.id, "Health Logs!A:D", logRows);

                    await ctx.reply(`✅ Successfully saved ${examRows.length} exams and ${logRows.length} logs.`);
                }
            } catch (jsonErr: any) {
                console.error("Sheet/JSON Error:", jsonErr, "Response was:", responseText);
            }

            // Caption and Knowledge Storage
            const caption = ctx.message.caption;
            let finalContent = text || responseText; // Fallback to raw text if verbatim markers failed
            if (caption) {
                finalContent = `[User Note: ${caption}]\n\n${finalContent}`;
            }

            await storeKnowledge(ctx.from.id, finalContent, doc.file_name || 'untitled', doc.mime_type || 'unknown');
            await ctx.reply(`Imported ${doc.file_name} into my knowledge base.`);

        } else {
            return ctx.reply('Sorry, I currently only support PDF and Text files.');
        }

    } catch (e: any) {
        console.error(e);
        ctx.reply('Error processing document: ' + e.message);
    }
});

// Photo Handler
bot.on('photo', async (ctx) => {
    try {
        const photos = ctx.message.photo;
        const fileId = photos[photos.length - 1].file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);

        await ctx.reply('Analyzing image...');
        const buffer = await downloadFile(fileLink.href);
        const base64Data = encodeBase64(new Uint8Array(buffer));

        const modelVision = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });

        const result = await modelVision.generateContent([
            "Describe this image in detail and extract any visible text. Output raw text.",
            {
                inlineData: {
                    data: base64Data,
                    mimeType: "image/jpeg"
                }
            }
        ]);
        const response = await result.response;
        const description = response.text();

        // 2. Extract structured health data from image
        const structuredPrompt = `Extract any health-related data (weight, body fat %, measurements, or medical results) from this image. 
        Output ONLY a valid JSON array of arrays: [Type, Value, Unit, Note, Date]. 
        If no data is found, output [].`;

        const structuredResult = await modelVision.generateContent([
            structuredPrompt,
            { inlineData: { data: base64Data, mimeType: "image/jpeg" } }
        ]);

        try {
            const jsonText = structuredResult.response.text().replace(/```json|```/g, "").trim();
            const values = JSON.parse(jsonText);
            if (Array.isArray(values) && values.length > 0) {
                await ctx.reply(`Detected ${values.length} health measurements in image. Saving...`);
                const timestamp = new Date().toISOString();
                const caption = ctx.message.caption;
                const defaultDate = caption || timestamp;
                const rowsToAppend = values.map((v: any[]) => [
                    v[4] || defaultDate, // Date (v[4] from [Type, Value, Unit, Note, Date])
                    v[0] || "Health Logs", // Type
                    v[3] || "Image", // Note/Detail
                    v[1] || "" // Value
                ]);
                await appendToSheet(ctx.from.id, "Health Logs!A:D", rowsToAppend);
                await ctx.reply("Measurements recorded in 'Health Logs'.");
            }
        } catch (jsonErr) {
            console.log("Image structured extraction failed or no data:", jsonErr);
        }

        await storeKnowledge(ctx.from.id, description, 'Uploaded Image', 'image/jpeg');
        await ctx.reply('Image stored: ' + description.substring(0, 100) + '...');
    } catch (e) {
        console.error(e);
        ctx.reply('Error processing image.');
    }
});

// Text Handler
bot.on('text', async (ctx) => {
    try {
        const userId = ctx.message.from.id;
        const userText = ctx.message.text;

        // 1. Health Log & Medication Detection
        const logPrompt = `You are a data extractor. Analyze the user message: "${userText}".
        
        CRITICAL: If the user is asking to record/set a medication reminder or injection schedule, extract the details.
        
        Possible Outputs:
        A) Health log (weight/measure): Output JSON { "type": "log", "category": "weight"|"measurement", "detail": string, "value": string }
        B) Medication/Injection reminder: Output JSON { 
            "type": "medication", 
            "name": string, 
            "morning": "HH:MM"|null, 
            "evening": "HH:MM"|null,
            "days": number[]|null, (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat)
            "frequency": number|null (days)
        }
        C) Neither: Output exactly "NO_LOG"
        
        Do NOT include any conversational text. Output ONLY the JSON or "NO_LOG".`;

        const logResult = await model.generateContent(logPrompt);
        const logResponse = logResult.response.text().trim();

        if (logResponse !== "NO_LOG") {
            try {
                const cleanedLog = logResponse.replace(/```json|```/g, "").trim();
                const data = JSON.parse(cleanedLog);

                if (data.type === "log") {
                    const timestamp = new Date().toISOString();
                    try {
                        await appendToSheet(userId, "Health Logs!A:D", [[timestamp, data.category, data.detail, data.value]]);
                        await ctx.reply(`✅ Registrado ${data.category}: ${data.value} (${data.detail})`);
                    } catch (sheetErr) {
                        console.error("Sheet Log Error:", sheetErr);
                        await ctx.reply("⚠️ El registro de salud se guardó en DB pero falló en Google Sheets.");
                    }
                } else if (data.type === "medication") {
                    console.log("Adding medication:", data.name, "Days:", data.days, "Freq:", data.frequency);
                    const { error } = await supabase.from('medications').insert({
                        user_id: userId,
                        name: data.name,
                        morning_time: data.morning,
                        evening_time: data.evening,
                        days_of_week: data.days,
                        frequency_days: data.frequency,
                        start_date: new Date().toISOString().split('T')[0]
                    });

                    if (error) {
                        console.error("Supabase Med Insert Error:", error);
                        return ctx.reply("❌ Error al guardar el medicamento en la base de datos: " + error.message);
                    }

                    const timestamp = new Date().toISOString();
                    try {
                        await appendToSheet(userId, "Medications!A:G", [[
                            timestamp,
                            data.name,
                            data.morning,
                            data.evening,
                            'active',
                            data.days ? data.days.join(',') : '',
                            data.frequency || ''
                        ]]);

                        let msg = `✅ Entendido. Te recordaré tomar **${data.name}**`;
                        if (data.morning) msg += ` a las ${data.morning}`;
                        if (data.evening) msg += ` y a las ${data.evening}`;

                        if (data.days) {
                            const dayNames = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
                            msg += ` los días: ${data.days.map((d: number) => dayNames[d]).join(', ')}`;
                        } else if (data.frequency) {
                            msg += ` cada ${data.frequency} días`;
                        } else {
                            msg += ` todos los días`;
                        }

                        msg += ` (Registrado en Sheets)`;
                        await ctx.replyWithMarkdown(msg);
                    } catch (sheetErr) {
                        console.error("Sheet Med Log Error:", sheetErr);
                        await ctx.reply(`✅ ${data.name} guardado en DB, pero falló el registro en Google Sheets. Revisa si la pestaña 'Medications' existe.`);
                    }
                }
                console.log("Log Response:", logResponse);
            } catch (e: any) {
                console.error("AI Log parsing failed:", e.message, "Response was:", logResponse);
                // Don't reply with error to user here, let it fall back to normal chat if it wasn't a log
            }
        }

        console.log("Fetching message history...");
        // 2. Fetch History
        const { data: historyData } = await supabase
            .from('messages')
            .select('role, content')
            .eq('chat_id', userId)
            .order('created_at', { ascending: false })
            .limit(10);

        // 3. Retrieve Knowledge & Historical Sheet Data
        const knowledge = await retrieveKnowledge(userId, userText);
        let sheetContext = "";

        if (userText.toLowerCase().includes("compara") || userText.toLowerCase().includes("historial") || userText.toLowerCase().includes("evolución")) {
            const exams = await getSheetValues(userId, "Medical Exams!A:G");
            const logs = await getSheetValues(userId, "Health Logs!A:D");
            sheetContext = `[Historical Health Data from Google Sheets]\nExams:\n${JSON.stringify(exams.slice(-20))}\n\nLogs:\n${JSON.stringify(logs.slice(-20))}`;
        }

        // 4. Construct Context
        let systemInstruction = "You are a developed AI assistant specialized in health tracking. You have access to the user's uploaded documents AND their historical health records from Google Sheets. Your goal is to provide accurate comparisons, detect trends, and answer health questions neutrally and scientifically.";

        systemInstruction += "\n\nIMPORTANT: Provide your response in PLAIN TEXT only. Do NOT use markdown formatting.";

        if (knowledge) systemInstruction += `\n\nRetrieved Information from Documents:\n${knowledge}`;
        if (sheetContext) systemInstruction += `\n\nRelevant Data from Google Sheets:\n${sheetContext}`;

        const history = (historyData || []).reverse().map((msg: any) => ({
            role: msg.role === 'model' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        const chat = model.startChat({
            history: history,
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: { maxOutputTokens: 8192 },
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE }
            ]
        });

        console.log('Sending message to Gemini with system instruction length:', systemInstruction.length);
        const result = await chat.sendMessage(userText);
        console.log('Gemini sendMessage finished.');
        const text = result.response.text();

        if (!text) {
            await ctx.reply('Error: Empty response from AI.');
            return;
        }

        await sendLongMessage(ctx, text);

        await supabase.from('messages').insert({ chat_id: userId, role: 'user', content: userText });
        await supabase.from('messages').insert({ chat_id: userId, role: 'model', content: text });

    } catch (error) {
        console.error('Error generating AI response:', error);
        await ctx.reply('Sorry, I encountered an error.');
    }
});
