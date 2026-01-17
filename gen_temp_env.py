
import json

with open("/Users/alfredoterraza/Downloads/asistente-fitness-484515-61d2d0c784b3.json", "r") as f:
    data = json.load(f)

# Write to a temp .env file
with open("temp.env", "w") as f:
    f.write(f"GOOGLE_PRIVATE_KEY=\"{data['private_key']}\"\n")
    f.write(f"GOOGLE_SERVICE_ACCOUNT_EMAIL=\"{data['client_email']}\"\n")
