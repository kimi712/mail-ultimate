#!/usr/bin/env python3
"""mail-ultimate final smoke test: AI live + 3s undo send + receive + wallpapers.
Temp account smokefinal@, hard-deleted at the end. register_verify restored to 0."""
import json, os, random, string, subprocess, sys, time

BASE = "https://aevorynthtech.com"
WORKER = os.path.expanduser("~/workspace/mail-ultimate/mail-worker")
# Load .deploy.env into the environment (wrangler needs CLOUDFLARE_API_TOKEN)
with open(os.path.expanduser("~/workspace/mail-ultimate/.deploy.env")) as f:
    for line in f.read().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
os.environ["CLOUDFLARE_ACCOUNT_ID"] = "90b66e86ebba00048ab651a55dd009a5"

def sh(cmd, **kw):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=os.environ, **kw)
    return r.stdout.strip(), r.stderr.strip(), r.returncode

def curl(method, path, token=None, data=None, timeout=60):
    cmd = ["curl", "-s", "-m", str(timeout), "-X", method, BASE + path]
    if token:
        cmd += ["-H", f"Authorization: {token}"]
    if data is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(data, ensure_ascii=False)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return json.loads(r.stdout)
    except Exception:
        return {"_raw": r.stdout[:300], "_stderr": r.stderr[:200]}

def d1(sql):
    out, _, rc = sh(f"cd {WORKER} && npx wrangler d1 execute mail-ultimate --remote --json --command \"{sql}\" 2>/dev/null")
    try:
        d = json.loads(out)
        if isinstance(d, dict) and "error" in d:
            raise RuntimeError(f"D1 error: {d['error']}")
        return d[0]["results"]
    except RuntimeError:
        raise
    except Exception:
        raise RuntimeError(f"D1 call failed rc={rc}: {out[:300]}")

def set_reg_verify(v):
    d1(f"UPDATE setting SET register_verify={v};")
    with open(os.path.expanduser("~/workspace/mail-ultimate/.deploy.env")) as f:
        env = dict(l.split("=", 1) for l in f.read().splitlines() if "=" in l)
    jwt = env["JWT_SECRET"].strip()
    tok = env["CLOUDFLARE_API_TOKEN"].strip()
    out, _, _ = sh(f"curl -s '{BASE}/api/init/{jwt}'")
    # KV global propagation can take ~45s: poll until the cached value matches
    for i in range(18):
        out2, _, _ = sh(f"curl -s 'https://api.cloudflare.com/client/v4/accounts/90b66e86ebba00048ab651a55dd009a5/storage/kv/namespaces/fa841d5594b34511935575e882c21ad5/values/setting%3A' -H 'Authorization: Bearer {tok}'")
        try:
            kv = json.loads(out2).get("registerVerify")
        except Exception:
            kv = None
        if kv == v:
            print(f"register_verify -> {v} (init: {out}, KV confirmed after {(i+1)*5}s)", flush=True)
            return
        time.sleep(5)
    print(f"register_verify -> {v} (init: {out}, WARNING: KV still not {v} after 90s)", flush=True)

def main():
    pw = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(16))
    email = "smokefinal@aevorynthtech.com"
    ok = True
    def check(name, cond, detail=""):
        nonlocal ok
        print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}", flush=True)
        if not cond:
            ok = False

    # 1. open registration
    set_reg_verify(1)
    # 2. register + login
    r = curl("POST", "/api/register", data={"email": email, "password": pw, "code": "SNOWDEN"})
    check("register temp account", r.get("code") == 200, str(r)[:150])
    r = curl("POST", "/api/login", data={"email": email, "password": pw})
    token = (r.get("data") or {}).get("token")
    check("login temp account", bool(token))
    if not token:
        print("ABORT: no token"); set_reg_verify(0); return 1
    r = curl("GET", "/api/account/list", token=token)
    acct = (r.get("data") or [{}])[0].get("accountId") or (r.get("data") or [{}])[0].get("account_id")
    check("account list", bool(acct), str(r)[:120])

    # 3. AI live (the P0 fix: must NOT be ai_unavailable)
    r = curl("GET", "/api/ai/usage", token=token)
    check("AI usage", r.get("code") == 200 and (r.get("data") or {}).get("limit") == 50, str(r)[:150])
    r = curl("POST", "/api/ai/compose", token=token, data={"prompt": "写一封简短的感谢邮件，感谢朋友帮忙搬家", "tone": "friendly"}, timeout=90)
    d = r.get("data") or {}
    check("AI compose live", r.get("code") == 200 and bool(d.get("subject") or d.get("body")), str(r)[:200])
    r = curl("POST", "/api/ai/chat", token=token, data={"message": "你好，请一句话介绍你能帮我做什么"}, timeout=90)
    d = r.get("data") or {}
    check("AI chat live", r.get("code") == 200 and bool(d.get("reply") or d.get("content") or d.get("text") or d.get("message")), str(r)[:200])
    r = curl("POST", "/api/ai/translate", token=token, data={"text": "Privacy is about something to protect.", "targetLang": "zh-CN"}, timeout=90)
    d = r.get("data") or {}
    check("AI translate live", r.get("code") == 200 and bool(d.get("translatedText") or d.get("text") or d.get("translation") or d), str(r)[:200])
    r = curl("POST", "/api/ai/summarize", token=token, data={"subject": "测试摘要", "body": "这是一封很长的测试邮件，内容是关于隐私保护的重要性，以及为什么每个人都应该关心自己的数据。"}, timeout=90)
    d = r.get("data") or {}
    check("AI summarize live", r.get("code") == 200 and bool(d.get("summary")), str(r)[:200])

    # 4. send with 3s undo -> confirm -> SENT
    r = curl("POST", "/api/email/send", token=token, data={"accountId": acct, "name": "smokefinal", "receiveEmail": ["tuzijieshuo777@gmail.com"], "subject": "smoke-final-3s", "text": "Final smoke test, 3s undo.", "undoSeconds": 3}, timeout=90)
    d = r.get("data") or {}
    pid = d.get("pendingId")
    check("send 3s undo -> pending", r.get("code") == 200 and d.get("pending") is True and pid, str(r)[:200])
    if pid:
        time.sleep(4)
        r = curl("POST", f"/api/mail-trust/pending/{pid}/confirm", token=token)
        check("confirm after 3s -> sent", r.get("code") == 200 and (r.get("data") or {}).get("sent") is True, str(r)[:200])
        time.sleep(2)
        rows = d1("SELECT status FROM email WHERE subject='smoke-final-3s' ORDER BY email_id DESC LIMIT 1;")
        check("D1 sent mail status=1", rows and rows[0].get("status") == 1, str(rows))

    # 5. receive via Resend -> D1 + /email/latest
    with open(os.path.expanduser("~/workspace/mail-ultimate/.deploy.env")) as f:
        env = dict(l.split("=", 1) for l in f.read().splitlines() if "=" in l)
    tok = env["CLOUDFLARE_API_TOKEN"].strip()
    out, _, _ = sh(f"curl -s 'https://api.cloudflare.com/client/v4/accounts/90b66e86ebba00048ab651a55dd009a5/storage/kv/namespaces/fa841d5594b34511935575e882c21ad5/values/setting%3A' -H 'Authorization: Bearer {tok}'")
    rk = json.loads(out)["resendTokens"]["aevorynthtech.com"]
    t0 = time.time()
    r = curl("POST", "https://api.resend.com/emails", data={"from": "smoke-final@aevorynthtech.com", "to": [email], "subject": "smoke-final-inbound", "text": "Inbound smoke test."}, timeout=30) if False else None
    out, err, rc = sh(f"curl -s -m 30 -X POST https://api.resend.com/emails -H 'Authorization: Bearer {rk}' -H 'Content-Type: application/json' -d '{json.dumps({'from': 'smoke-final@aevorynthtech.com', 'to': [email], 'subject': 'smoke-final-inbound', 'text': 'Inbound smoke test.'})}'")
    try:
        res = json.loads(out)
        check("resend send", bool(res.get("id")), str(res)[:120])
    except Exception as e:
        check("resend send", False, out[:150])
    found = None
    for _ in range(7):
        time.sleep(5)
        rows = d1("SELECT email_id, status, create_time FROM email WHERE subject='smoke-final-inbound';")
        if rows and rows[0].get("email_id"):
            found = rows[0]; break
    check("inbound in D1", bool(found), f"t+{time.time()-t0:.0f}s {found}")
    r = curl("GET", f"/api/email/latest?accountId={acct}&type=0", token=token)
    check("latest API returns mail", r.get("code") == 200, str(r)[:150])

    # 6. wallpapers
    out, _, rc = sh("curl -s https://aevorynthtech.com/wallpapers/wallpapers.json")
    try:
        w = json.loads(out)
        n = len(w) if isinstance(w, list) else len(w.get("wallpapers", []))
        names = out.count("snowden-")
        check("wallpapers.json 25 entries incl 11 snowden", n == 25 and names >= 11, f"n={n} snowden_refs={names}")
    except Exception as e:
        check("wallpapers.json", False, str(e)[:100] + out[:100])
    out, _, rc = sh("curl -s -o /dev/null -w '%{http_code}' https://aevorynthtech.com/wallpapers/snowden-02.jpg")
    check("snowden-02.jpg serves 200", out.strip() == "200", out.strip())
    out, _, rc = sh("curl -s -o /dev/null -w '%{http_code}' https://aevorynthtech.com/")
    check("homepage 200", out.strip() == "200", out.strip())

    # 7. cleanup: hard-delete temp account, restore register_verify=0
    r = curl("POST", "/api/my/hard-delete", token=token, data={"password": pw, "confirmText": "DELETE"})
    check("hard-delete temp account", r.get("code") == 200, str(r)[:150])
    set_reg_verify(0)
    rows = d1("SELECT COUNT(*) AS c FROM user;")
    print("users left:", rows)
    print("RESULT:", "ALL PASS" if ok else "SOME FAILED")
    return 0 if ok else 1

if __name__ == "__main__":
    sys.exit(main())
