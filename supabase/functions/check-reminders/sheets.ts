
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

    const payload = {
        iss: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        sub: GOOGLE_SERVICE_ACCOUNT_EMAIL,
        aud: "https://oauth2.googleapis.com/token",
        iat,
        exp,
        scope: "https://www.googleapis.com/auth/spreadsheets",
    };

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

    let cleanKey = GOOGLE_PRIVATE_KEY!.trim();
    if (cleanKey.startsWith('"') && cleanKey.endsWith('"')) {
        cleanKey = cleanKey.slice(1, -1);
    }
    const pem = cleanKey
        .replace(/-----BEGIN PRIVATE KEY-----/g, "")
        .replace(/-----END PRIVATE KEY-----/g, "")
        .replace(/\\n/g, "")
        .replace(/\\r/g, "")
        .replace(/\s/g, "");

    let binaryKey;
    try {
        binaryKey = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
    } catch (e) {
        throw new Error(`Failed to decode base64: ${e.message}.`);
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

// Updated to accept userId
export async function appendToSheet(userId: number, range: string, values: any[][]) {
    const token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`;

    // Prepend UserId to each row
    const rowsWithUser = values.map(row => [userId, ...row]);

    const response = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ values: rowsWithUser }),
    });

    if (!response.ok) {
        const err = await response.text();
        console.error(`Sheet Append Error [URL: ${url}]: ${err}`);
        throw new Error(`Google Sheets API Error: ${err}`);
    }
    console.log(`Successfully appended to range: ${range} for user ${userId}`);
    return await response.json();
}

// Updated to filter by userId
export async function getSheetValues(userId: number, range: string): Promise<any[][]> {
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
    const allRows = data.values || [];

    // Filter rows where the first column matches the userId
    // Note: Sheets API returns strings mostly, so loose equality or string conversation is safer
    return allRows.filter((row: any[]) => row[0] == userId);
}
