
async function sendLongMessage(mockCtx, text) {
    const MAX_LENGTH = 10; // Small length for testing

    let remainingText = text;

    while (remainingText.length > 0) {
        if (remainingText.length <= MAX_LENGTH) {
            await mockCtx.reply(remainingText);
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
        await mockCtx.reply(chunk);

        // Remove the sent chunk and leading whitespace from the rest
        remainingText = remainingText.substring(splitIndex).trimStart();
    }
}

const mockCtx = {
    reply: async (msg) => console.log(`[MSG]: "${msg}"`)
};

const testText = "This is a long message that needs to be split correctly.";
// Expected splits (approx): "This is a", "long", "message", "that", "needs to", "be split", "correctly."

console.log("Testing split logic:");
sendLongMessage(mockCtx, testText);
