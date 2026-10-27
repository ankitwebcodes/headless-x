import base64
pw = open(r"C:\Users\ankit\x_panel\scripts\qa_pw.txt").read().strip()
print(base64.b64encode(pw.encode()).decode())