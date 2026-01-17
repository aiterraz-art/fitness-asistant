import json
import subprocess
import os

# Credentials from investigation
bot_token = "8263517898:AAEFV1K9-KYPxuSkgw5kbx9Fhm1x459ILZ8"
gemini_key = "AIzaSyAKKzR7xd1bnI5KEy4bUtcdAEKZtCm77uk"
json_path = "/Users/alfredoterraza/Downloads/asistente-fitness-484515-61d2d0c784b3.json"
project_ref = "uuowqcvocfsprhoxldnf"

print("Reading Google Credentials...")
try:
    with open(json_path, "r") as f:
        data = json.load(f)
        private_key = data["private_key"]
        email = data["client_email"]
    print("Google Credentials loaded.")
except Exception as e:
    print(f"Error reading JSON: {e}")
    exit(1)

# Construct command
secrets = [
    f"BOT_TOKEN={bot_token}",
    f"GEMINI_API_KEY={gemini_key}",
    f"GOOGLE_PRIVATE_KEY={private_key}",
    f"GOOGLE_SERVICE_ACCOUNT_EMAIL={email}"
]

cmd = ["npx", "-y", "supabase", "functions", "secrets", "set", *secrets, "--project-ref", project_ref]

print("Executing secrets set command...")
try:
    subprocess.run(cmd, check=True)
    print("Secrets set successfully!")
except subprocess.CalledProcessError as e:
    print(f"Error setting secrets: {e}")
