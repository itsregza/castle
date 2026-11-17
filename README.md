# castle

Generates Castle.io request tokens. It runs Castle's own SDK in Node using a fingerprint recorded from a real Chrome.

## Usage

Needs Python 3.9+ and Node.js.

from castle import generate_token

t = generate_token("pk_...", "https://example.com/login")
print(t.to_json())
```

```json
{"token": "fHF9l_CXHuQ6XW95l0FG...", "user_agent": "Mozilla/5.0 ...", "ms": 989}
```

`pk` is the site's Castle key. Search the site's JS for `pk_`. Send the token in the site's Castle header with the same user agent.

See `example.py` for Topps USA.
