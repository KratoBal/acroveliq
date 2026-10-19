"""The relay client behind scripts/level-kozvetito.sh. One request, no retry (a verb may write: a repeated
archival is the relay's cap to judge, not this client's guess)."""
import json
import os
import re
import sys
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ACCOUNTS = ("info", "balazs")
VERB = re.compile(r"^[a-z][a-z-]{0,31}$")
TIMEOUT = 90


def fail(msg, code=1):
    sys.stderr.write("FAIL " + msg + "\n")
    raise SystemExit(code)


FIXED_URL = "http://levelkozvetito:8788"


def base_url():
    """The relay's address is FIXED. LVK_URL counts only for a loopback host (the tests start a relay on
    127.0.0.1): the caller is a model that reads mail, and an instruction in a mail must not be able to send the
    bearer token to a host of its choosing by setting one environment variable (barracuda, #250 review)."""
    url = os.environ.get("LVK_URL")
    if url is None or url == "":
        return FIXED_URL
    m = re.match(r"^http://(127\.0\.0\.1|localhost)(:\d{1,5})?/?$", url)
    if not m:
        fail("LVK_URL is honoured only for http://127.0.0.1[:port] or http://localhost[:port]; nothing was sent")
    return "http://" + m.group(1) + (m.group(2) or "")


def token():
    path = os.environ.get("LVK_TOKEN_FILE") or os.path.join(
        ROOT, "store", "tokens", "levelkozvetito-%s.token" % (os.environ.get("LVK_CALLER") or "acrobot")
    )
    try:
        value = open(path, encoding="utf-8").read().strip()
    except OSError:
        fail("the caller's token file is missing or unreadable: " + path)
    if not value or re.search(r"\s", value):
        fail("the caller's token file is empty or holds whitespace: " + path)
    return value


def reason(raw):
    # only the relay's own fixed `error` word is passed on; anything else is dropped
    try:
        text = json.loads(raw).get("error", "")
    except (ValueError, AttributeError):
        return "no reason given"
    return re.sub(r"[^\w .:/-]", "?", str(text))[:120] or "no reason given"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main(argv):
    opener = urllib.request.build_opener(NoRedirect)
    if argv == ["health"]:
        try:
            with opener.open(base_url() + "/healthz", timeout=15) as r:
                sys.stdout.write(r.read().decode("utf-8", "replace") + "\n")
            return 0
        except (urllib.error.URLError, OSError):
            fail("no answer from the relay")
    if len(argv) != 2 or argv[0] not in ACCOUNTS or not VERB.match(argv[1]):
        fail("usage: level-kozvetito.sh <info|balazs> <verb> < body.json   |   level-kozvetito.sh health", 2)
    raw = sys.stdin.read() if not sys.stdin.isatty() else ""
    try:
        body = json.loads(raw) if raw.strip() else {}
    except ValueError:
        fail("the body on STDIN is not JSON", 2)
    if not isinstance(body, dict):
        fail("the body on STDIN must be a JSON object", 2)
    req = urllib.request.Request(
        "%s/%s/%s" % (base_url(), argv[0], argv[1]),
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            sys.stdout.write(r.read().decode("utf-8", "replace") + "\n")
        return 0
    except urllib.error.HTTPError as e:
        fail("%d %s" % (e.code, reason(e.read(65536))))
    except (urllib.error.URLError, OSError):
        fail("no answer from the relay")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
