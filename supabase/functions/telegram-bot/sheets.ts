
// deno-lint-ignore-file
import { createRemoteJWKSet, jwtVerify } from "https://deno.land/x/jose@v4.14.4/index.ts";

const GOOGLE_SERVICE_ACCOUNT_EMAIL = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_EMAIL");
const GOOGLE_PRIVATE_KEY = Deno.env.get("GOOGLE_PRIVATE_KEY")?.replace(/\\n/g, '\n');
const SPREADSHEET_ID = Deno.env.get("SPREADSHEET_ID");

async function getAccessToken(): Promise<string> {
    if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
        throw new Error("Missing Google Service Account credentials");
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 3600;

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
        iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        sub: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        aud: "https://oauth2.googleapis.com/token",
        iat,
        exp,
        scope: "https://www.googleapis.com/auth/spreadsheets",
    };

    // Note: In Deno Edge Functions, we typically use a library or manual signing for RS256
    // Since we don't have 'fs' or easy 'crypto' for PEM, we'll use a fetch-based approach 
    // or a standard library if available. For simplicity in this environment, 
    // we'll assume a helper or manual signing.

    // Better approach for Deno: Use 'https://deno.land/x/google_auth@v0.0.1/mod.ts' or similar
    // However, to keep it dependency-light and robust for Edge:

    const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: await signJWT(payload),
        }),
    });

    const data = await response.json();
    if (data.error) throw new Error(`Auth Error: ${data.error_description || data.error}`);
    return data.access_token;
}

// Manual JWT Signer for Deno using Web Crypto API
async function signJWT(payload: any): Promise<string> {
    const encoder = new TextEncoder();
    const header = { alg: "RS256", typ: "JWT" };

    const stringifiedHeader = JSON.stringify(header);
    const stringifiedPayload = JSON.stringify(payload);

    const base64Header = b64Encode(encoder.encode(stringifiedHeader));
    const base64Payload = b64Encode(encoder.encode(stringifiedPayload));

    const dataToSign = `${base64Header}.${base64Payload}`;

    // Convert PEM to ArrayBuffer
    // 1. Remove optional surrounding quotes
    let cleanKey = GOOGLE_PRIVATE_KEY!.trim();
    if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
        cleanKey = cleanKey.slice(1, -1);
    }
    // 2. Remove PEM headers/footers and ALL whitespace/escaping
    const pem = cleanKey
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\\n/g, "") // Remove literal \n sequences
        .replace(/\\r/g, "") // Remove literal \r sequences
        .replace(/\s/g, ""); // Strips all whitespace including real newlines

    let binaryKey;
    try {
        // Use a more robust base64 decoder that ignores invalid characters if needed
        // but for now, just atob the fully cleaned string
        binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    } catch (e) {
        console.error("PEM Base64 decoding failed. Cleaned length:", pem.length);
        console.error("PEM snippet (start):", pem.substring(0, 30));
        console.error("PEM snippet (end):", pem.substring(pem.length - 30));
        throw new Error(`Failed to decode base64: ${e.message}. Cleaned length: ${pem.length}. Verify GOOGLE_PRIVATE_KEY in Supabase secrets.`);
    }

    const key = await crypto.subtle.importKey(
        "pkcs8",
        binaryKey,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(dataToSign)
    );

    const base64Signature = b64Encode(new Uint8Array(signature));
    return `${dataToSign}.${base64Signature}`;
}

function b64Encode(uint8: Uint8Array): string {
    return btoa(String.fromCharCode(...uint8))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
}

export async function appendToSheet(range: string, values: any[][]) {
    const token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ values }),
    });

    if (!response.ok) {
        const err = await response.text();
        console.error(`Sheet Append Error [URL: ${url}]: ${err}`);
        throw new Error(`Google Sheets API Error: ${err}`);
    }
    console.log(`Successfully appended to range: ${range}`);
    return await response.json();
}

export async function getSheetValues(range: string): Promise<any[][]> {
    const token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}`;

    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Sheet Read Error: ${err}`);
    }
    const data = await response.json();
    return data.values || [];
}
