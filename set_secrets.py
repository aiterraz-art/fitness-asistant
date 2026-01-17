
import json
import subprocess

with open("/Users/alfredoterraza/Downloads/asistente-fitness-484515-61d2d0c784b3.json", "r") as f:
    data = json.load(f)

private_key = data["private_key"]
email = data["client_email"]

# Set secrets via CLI
# We use a temp file or pipe to avoid shell escaping madness
cmd = ["npx", "supabase", "secrets", "set", f"GOOGLE_PRIVATE_KEY={private_key}", f"GOOGLE_SERVICE_ACCOUNT_EMAIL={email}", "--project-ref", "gwupbbikivgzuwuhspjr"]
subprocess.run(cmd, check=True)

print("Batch secrets updated successfully.")
