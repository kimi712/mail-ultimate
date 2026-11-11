#!/usr/bin/env python3
"""3-email send/receive speed test: 3 outbound (API->Gmail) + 3 inbound (Resend->temp acct).
Times each leg. Cleans up the temp account and restores register_verify=0."""
import json, os, random, string, subprocess, sys, time

BASE = "https://aevorynthtech.com"
WORKER = os.path.expanduser("~/workspace/mail-ultimate/mail-worker")
with open(os.path.expanduser("~/workspace/mail-ultimate/.deploy.env")) as f:
    for line in f.read().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())
os.environ["CLOUDFLARE_ACCOUNT_ID"] = "90b66e86ebba00048ab651a55dd009a5"

def sh(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, env=os.environ)
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
        return {"_raw": r.stdout[:200]}

def d1(sql):
    out, _, rc = sh(f"cd {WORKER} && npx wrangler d1 execute mail-ultimate --remote --json --command \"{sql}\" 2>/dev/null")
    d = json.loads(out)
    if isinstance(d, dict) and "error" in d:
        raise RuntimeError(f"D1 error: {d['error']}")
    return d[0]["results"]

def set_reg_verify(v):
    d1(f"UPDATE setting SET register_verify={v};")
    jwt = os.environ["JWT_SECRET"]
    tok = os.environ["CLOUDFLARE_API_TOKEN"]
    sh(f"curl -s '{BASE}/api/init/{jwt}'")
    for i in range(18):
        out, _, _ = sh(f"curl -s 'https://api.cloudflare.com/client/v4/accounts/90b66e86ebba00048ab651a55dd009a5/storage/kv/namespaces/fa841d5594b34511935575e882c21ad5/values/setting%3A' -H 'Authorization: Bearer {tok}'")
        try:
            kv = json.loads(out).get("registerVerify")
        except Exception:
            kv = None
        if kv == v:
            return
        time.sleep(5)
    raise RuntimeError(f"KV registerVerify did not become {v}")

def main():
    pw = "".join(random.choice(string.ascii_letters + string.digits) for _ in range(16))
    email = "speed3@aevorynthtech.com"
    print("=== 3封邮件收发速度测试 ===", flush=True)
    set_reg_verify(1)
    r = curl("POST", "/api/register", data={"email": email, "password": pw, "code": "SNOWDEN"})
    assert r.get("code") == 200, f"register failed: {r}"
    r = curl("POST", "/api/login", data={"email": email, "password": pw})
    token = (r.get("data") or {}).get("token")
    assert token, f"login failed: {r}"
    r = curl("GET", "/api/account/list", token=token)
    acct = (r.get("data") or [{}])[0].get("accountId")
    assert acct, f"account list failed: {r}"
    print(f"temp account {email} ready (accountId {acct})", flush=True)

    # --- 3 outbound: API send -> Gmail, undoSeconds=0 (immediate) ---
    send_times = []
    for i in (1, 2, 3):
        t0 = time.time()
        r = curl("POST", "/api/email/send", token=token,
                 data={"accountId": acct, "name": "speed3", "receiveEmail": ["tuzijieshuo777@gmail.com"],
                       "subject": f"speed3-out-{i}", "text": f"Speed test outbound {i}.", "undoSeconds": 0}, timeout=60)
        dt = time.time() - t0
        ok = r.get("code") == 200
        send_times.append(dt)
        print(f"发信 {i}: {'OK' if ok else 'FAIL'}  {dt:.2f}s  {str(r)[:120]}", flush=True)

    # --- 3 inbound: Resend -> temp account, time to D1 ---
    rk = json.loads(sh("curl -s 'https://api.cloudflare.com/client/v4/accounts/90b66e86ebba00048ab651a55dd009a5/storage/kv/namespaces/fa841d5594b34511935575e882c21ad5/values/setting%3A' -H 'Authorization: Bearer " + os.environ["CLOUDFLARE_API_TOKEN"] + "'")[0])["resendTokens"]["aevorynthtech.com"]
    in_times = []
    for i in (1, 2, 3):
        subj = f"speed3-in-{i}"
        t0 = time.time()
        out, _, _ = sh(f"curl -s -m 30 -X POST https://api.resend.com/emails -H 'Authorization: Bearer {rk}' -H 'Content-Type: application/json' -d '{json.dumps({'from': 'speed3@aevorynthtech.com', 'to': [email], 'subject': subj, 'text': f'Speed test inbound {i}.'})}'")
        try:
            rid = json.loads(out).get("id")
        except Exception:
            rid = None
        if not rid:
            print(f"收信 {i}: Resend 发送失败 {out[:120]}", flush=True)
            in_times.append(None)
            continue
        found = None
        for _ in range(12):
            time.sleep(3)
            rows = d1(f"SELECT email_id, create_time FROM email WHERE subject='{subj}';")
            if rows and rows[0].get("email_id"):
                found = rows[0]
                break
        dt = time.time() - t0
        in_times.append(dt if found else None)
        print(f"收信 {i}: {'OK' if found else 'TIMEOUT'}  {dt:.1f}s  (resend id {rid[:13]}...)", flush=True)

    # --- cleanup ---
    r = curl("POST", "/api/my/hard-delete", token=token, data={"password": pw, "confirmText": "DELETE"})
    print("hard-delete temp account:", r.get("code"), flush=True)
    set_reg_verify(0)
    rows = d1("SELECT COUNT(*) AS c FROM user;")
    ok_s = [t for t in send_times]
    ok_i = [t for t in in_times if t is not None]
    print(f"--- 结果：发信 {len(ok_s)}/3 成功，平均 {sum(ok_s)/len(ok_s):.2f}s，最快 {min(ok_s):.2f}s，最慢 {max(ok_s):.2f}s", flush=True)
    if ok_i:
        print(f"--- 结果：收信 {len(ok_i)}/3 成功，平均 {sum(ok_i)/len(ok_i):.1f}s，最快 {min(ok_i):.1f}s，最慢 {max(ok_i):.1f}s", flush=True)
    else:
        print("--- 结果：收信 0/3 成功", flush=True)
    print("users left:", rows, flush=True)
    return 0 if len(ok_s) == 3 and len(ok_i) == 3 else 1

if __name__ == "__main__":
    sys.exit(main())
