require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

async function main() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" }); // Dummy init to access basics? No, need direct list.
        // Actually SDK doesn't expose listModels directly on genAI instance easily in all versions?
        // Let's check if I can use the API directly or if the SDK has a helper.
        // The error message recommended "Call ListModels". In Node SDK it might be implicit or just not exposed easily on the main Helper.
        // Let's try to just curl it or use a simple fetch if SDK is obscure, but SDK usually has it.
        // Looking at docs (simulated): genAI.getGenerativeModel is the main entry. 
        // Actually, there is no direct listModels on the main class in some versions.
        // Let's try to use a known stable model 'gemini-pro'.

        console.log("Testing gemini-3-pro-preview...");
        const modelPro = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
        const res = await modelPro.generateContent("Hello");
        console.log("gemini-3-pro-preview works! Response:", res.response.text());
    } catch (error) {
        console.error("gemini-3-pro-preview failed:", error.message);
    }
}

main();
