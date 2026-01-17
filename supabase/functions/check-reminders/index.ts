import { createClient } from "jsr:@supabase/supabase-js@2";
import { appendToSheet } from "./sheets.ts";

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
    try {
        const now = new Date();

        // Adjust to User's Local Time (UTC-3)
        // We add the offset in milliseconds (3 hours * 60 min * 60 sec * 1000 ms)
        const offset = -3 * 60 * 60 * 1000;
        const localNow = new Date(now.getTime() + offset);

        const currentTime = localNow.toISOString().substring(11, 16); // "HH:MM"
        const todayStr = localNow.toISOString().split('T')[0];
        const dayOfWeek = localNow.getUTCDay(); // 0=Sunday, 1=Monday...

        console.log(`[UTC: ${now.toISOString()}] Checking for Local Time: ${currentTime} (Day: ${dayOfWeek}, Date: ${todayStr})...`);

        // 1. Process NEW doses
        const { data: activeMeds } = await supabase
            .from('medications')
            .select('*')
            .eq('active', true)
            .or(`morning_time.eq.${currentTime},evening_time.eq.${currentTime}`);

        if (activeMeds) {
            for (const med of activeMeds) {
                let shouldRemind = false;

                // Schedule check
                if (med.days_of_week && med.days_of_week.length > 0) {
                    if (med.days_of_week.includes(dayOfWeek)) shouldRemind = true;
                } else if (med.frequency_days) {
                    const startDate = new Date(med.start_date);
                    const diffTime = Math.abs(now.getTime() - startDate.getTime());
                    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
                    if (diffDays % med.frequency_days === 0) shouldRemind = true;
                } else {
                    // Default daily
                    shouldRemind = true;
                }

                if (shouldRemind) {
                    const slot = (med.morning_time === currentTime) ? 'morning' : 'evening';

                    // Try to create the reminder (unique constraint handles duplicates)
                    const { data: reminder, error: insertError } = await supabase
                        .from('medication_reminders')
                        .insert({
                            med_id: med.id,
                            user_id: med.user_id,
                            scheduled_date: todayStr,
                            slot: slot,
                            status: 'pending'
                        })
                        .select()
                        .single();

                    if (!insertError && reminder) {
                        await sendReminderAlert(med, reminder.id);
                    }
                }
            }
        }

        // 2. Process SNOOZED/PENDING re-alerts
        const { data: pending } = await supabase
            .from('medication_reminders')
            .select('*, medications!inner(name, active)')
            .in('status', ['pending', 'snoozed'])
            .eq('medications.active', true)
            .lte('next_check', now.toISOString());

        if (pending) {
            for (const rem of pending) {
                // If it's been more than 5 minutes since scheduled and it's still pending (not snoozed/taken)
                // Or if it's snoozed and time reached.
                await sendReminderAlert(rem.medications, rem.id, true);

                // Push next check 30m
                const future = new Date(now.getTime() + 30 * 60000).toISOString();
                await supabase
                    .from('medication_reminders')
                    .update({ next_check: future })
                    .eq('id', rem.id);
            }
        }

        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
    } catch (err) {
        console.error(err);
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
});

async function sendReminderAlert(med: any, reminderId: number, isRetry = false) {
    const prefix = isRetry ? "⏰ *RE-AVISO*: " : "💊 *Recordatorio*: ";
    const message = `${prefix}Es hora de tomar *${med.name}*.\n\n¿Ya lo tomaste?`;

    const keyboard = {
        inline_keyboard: [[
            { text: "Lo tomé ✅", callback_data: `med_taken_${reminderId}` },
            { text: "En 30 min ⏳", callback_data: `med_snooze_${reminderId}` }
        ]]
    };

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: med.user_id || 6149934349, // Fallback if missing, but should be there
            text: message,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        })
    });
}
